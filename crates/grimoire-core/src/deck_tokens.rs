//! The tokens and emblems a deck needs — derived from `all_parts` on every open — and the
//! printings the reader keeps of them, per list.
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
//!               cards.raw text ─▶ MARKERS ─▶ helper by name  (The Monarch, The Ring, …)
//!                                                     │
//!               group by ORACLE ID ──┬── LEFT JOIN deck_tokens          (the token's state)
//!                                    └── deck_token_printings, per list (its entries)
//! ```
//!
//! # Which tokens is derived; which printings is stored
//!
//! **Which tokens a list needs is recomputed on every open** — measured at ~5 ms in Node for a
//! denser-than-typical 100-card pool, and Rust beats that, because only the cards in the open
//! deck are ever inflated. A *stored* list would go stale the next time a Scryfall sync changed a
//! card's `all_parts`, with nothing to notice.
//!
//! **Which printings of each token the reader keeps is stored**, since user schema v52, because
//! nothing can derive it: an **entry** is one printing in one finish of one token in one list
//! (`live` or `theory`), with a quantity — [`crate::schema::DECK_TOKEN_PRINTING_GRAIN`]. A token
//! the list derives and holds no entries of draws one **implicit** entry: the resolver's default
//! printing in its default finish, at `deck_tokens.quantity ?? 0` — **zero since user schema
//! v55**, because a token is something the reader starts to use (the token-improvements spec
//! §3.1). A token the reader added by hand draws only the entries it has in that list, and none
//! in a list with none. `deck_tokens` keeps what is shared by both
//! lists — the token's **state**, `auto`, `hidden` or `manual` — and its `card_id` and `quantity`
//! are legacy: read for an implicit entry, and written again only by [`convert_legacy_picks`],
//! which turns a v51 pick into entries and clears it — at launch on a device in no sync group,
//! and on one in a group behind a pull ([`convert_legacy_picks_at_launch`] says why). Spec §4.2's seven rules are this
//! module's writes, and the one that reaches every card write is rule 7, [`reconcile_in`].
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
//! Rust supplies *facts* and TypeScript draws *conclusions*, the crate root's rule. Which rows the
//! stacks draw and what order the wall is in are `packages/ui/features/decks/deckTokens.ts`'s; a `hidden`
//! row is answered here like any other — and since user schema v55 nothing hides one:
//! [`retire_hidden`] turns every dismissal back into an ordinary token at launch. **What an implicit entry *is* is answered
//! here and not there**, since v52, because a write has to be able to materialise it (rule 2) and
//! the two halves must not be able to disagree about which printing that is.
//!
//! **A token's name does not identify it**, which is why [`DeckTokenRow`] carries four fields no
//! resolver needs. 104 token/emblem names in the corpus are shared by more than one `oracle_id` —
//! `Elemental` by 31, `Spirit` by 22, `Soldier` by 13 — and `Wurmcoil Engine` alone puts two
//! tokens both called `Wurm` in one deck, separated only by Deathtouch and Lifelink. Power,
//! toughness, colors and oracle text together told 8 of 8 apart in both sampled names (debug
//! corpus, 2026-09-07), and two tiles announcing one accessible name is a bug that has already
//! shipped once on the collection wall.
//!
//! # The chin and the price
//!
//! A token drawn in a deck view's pile wears the chin every deck card wears — set, number,
//! rarity, finish — and a price its pile heading sums. **All of it is the entry's printing**,
//! and the price is that printing in the marketplace the command was asked for, **at the entry's
//! finish** ([`crate::sorting::price_expr`]) — `None` where the marketplace has no figure: never
//! a zero, and never another finish's or another marketplace's. Until v52 a token had no finish
//! of its own and was priced as a deck row naming none is, down `nonfoil → foil → etched`; an
//! entry always names one, and a foil Treasure is not priced as the nonfoil one.
//!
//! # Every token write is a deck write
//!
//! **One `deck_audit` row of kind `deck` with `field: "token"`, and one `deck_undo` step**, for
//! each of the four writes — which reverses what this module said until v52, that token writes
//! record nothing. (Five until v55, which retired the state write and the reset and added
//! [`remove_entry`].) Never a new audit kind: `deck_audit` syncs, a word a paired device's `CHECK`
//! does not know would be refused there, and its applier would defer the op — which a v51 client
//! drops, taking the rest of that device's page with it, and a v52 or later client holds, pinning
//! the relay's log until it upgrades (`sync.md`, *Held while it can resolve, skipped when it
//! cannot*). [`journal_in`] is the one place the four record, so they cannot differ in how.

use crate::deck_undo::{Op, Step, TokenEntryRow, TokenStateRow};
use crate::schema::{DECK_TOKEN_GRAIN, DECK_TOKEN_PRINTING_GRAIN};
use crate::sorting::Marketplace;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

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

/// The layouts that make a printing a token or an emblem **by themselves** — the first half of
/// [`is_token_printing`], and not the whole of it.
///
/// Every row of these three is `legal_mask = 0`, so none could ever be a card a deck plays.
/// `deckTokens.ts`' `isTokenLayout` is the TypeScript twin, for drawing.
const TOKEN_LAYOUTS: [&str; 3] = ["token", "double_faced_token", "emblem"];

/// The two layouts a token *can* wear without being one — the second half of
/// [`is_token_printing`], answered by the type line.
///
/// **This is the half a layout-only test gets wrong, and it is the keep rule's `flip` 75 and
/// `reversible_card` 3 from the other side.** Those 78 `all_parts` entries resolve to **six**
/// printings — five `flip` Role tokens (`Royal // Young Hero`, `Wicked // Cursed`, …) and the
/// `reversible_card` `Mechtitan` — while the same two layouts hold 81 + 39 real cards (the
/// reversible legends and planeswalkers, Kamigawa's flip cards, the double-sided basics). Measured
/// on the debug corpus, 2026-09-26.
const TWO_SIDED_LAYOUTS: [&str; 2] = ["flip", "reversible_card"];

/// The words a [`TWO_SIDED_LAYOUTS`] printing's type line — or any ` // ` face of it — begins with
/// when it is a token or an emblem: the second half of [`is_token_printing`], and the same words
/// [`list_token_printings`] asks SQL for, so the two cannot be spelled apart.
const TOKEN_LINE_WORDS: [&str; 2] = ["Token", "Emblem"];

/// The layouts a **game helper** is filed under — [`is_listed_token`]'s second half. The two
/// [`TOKEN_LAYOUTS`] a card with no `Token` face can wear; every helper on the debug corpus is one
/// of them (measured 2026-09-28), and an `emblem` row always names its `Emblem`.
const HELPER_LAYOUTS: [&str; 2] = ["token", "double_faced_token"];

/// The `sets.set_type`s whose helper cards belong to **another game** than the one a deck is
/// played in — the World Championship decks' ads, bios and decklists and the Theros challenge
/// decks (`memorabilia`), and the booster minigames (`minigame`). [`is_listed_token`] leaves their
/// helpers out; a real token in such a set is listed like any other.
const OTHER_GAME_SET_TYPES: [&str; 2] = ["memorabilia", "minigame"];

/// The type line a helper face carries — `Card`, exactly, on one ` // ` face or the only one: The
/// Monarch, Day // Night, Undercity // The Initiative, Punchcard.
const HELPER_FACE: &str = "Card";

/// The words every face-down reminder card's text carries — Manifest, Morph, A Mysterious Creature
/// and the Doctor Who Cyberman, whose type line is a creature's rather than [`HELPER_FACE`].
const FACE_DOWN_WORDS: &str = "face-down";

/// A face a **dungeon** begins with — `Dungeon — Tomb of Annihilation`, and the
/// `Dungeon — Undercity` face The Initiative already wears. The second helper face beside [`HELPER_FACE`]: a dungeon is
/// a card a deck that ventures brings to the table, and no dungeon's line is ever exactly `Card`.
const DUNGEON_FACE: &str = "Dungeon";

/// A **game marker**: a helper card a deck brings to the table because one of its cards' rules
/// text says so, whatever that card's `all_parts` names — issue #670.
///
/// **Why `all_parts` is not enough.** The keep rule is `component == token` or a target laid out
/// `emblem`, and a helper is neither: The Monarch, Undercity // The Initiative and City's Blessing
/// are laid out `token` / `double_faced_token` with a `Card` face, and a real card names one as a
/// `combo_piece` when it names it at all. A helper is not a token by type, so widening the keep
/// rule to every `combo_piece` helper would also derive Morph for 402 cards and every Plot,
/// Foretell and Adventure reminder. The mechanics a player tracks *with* a card, as they track a
/// Treasure, are the ones listed here, and a card's text is what says it plays one.
struct Marker {
    /// Lower-case phrases; a maker whose text holds any one of them, on any face, plays the
    /// mechanic. Matched against [`rules_text`], which folds case and the curly apostrophe.
    words: &'static [&'static str],
    /// The helper cards' **whole** names, as `cards.name` holds them — ` // ` and all for a
    /// two-faced helper. Every name that resolves is kept: venturing brings all three dungeons.
    /// **A name the corpus does not hold resolves to nothing**, never an error, so a guessed
    /// spelling costs a missing tile and not a deck that will not open.
    helpers: &'static [&'static str],
}

/// Every [`Marker`] the resolver reads a maker's text for, in no order that matters.
///
/// The Monarch, Day // Night, City's Blessing and Start Your Engines! // Max Speed are spelled as
/// the debug corpus and the Storybook corpus hold them, and Undercity // The Initiative is the
/// `Dungeon — Undercity // Card` row the helper tests take from it. **The Ring's and the three
/// dungeons' spellings were not measured** — this module was written without corpus access — so
/// The Ring carries every spelling its reminder card goes by, and a spelling that matches nothing
/// costs nothing.
const MARKERS: [Marker; 7] = [
    Marker {
        words: &["become the monarch", "becomes the monarch"],
        helpers: &["The Monarch"],
    },
    Marker {
        words: &["the ring tempts you"],
        helpers: &[
            "The Ring",
            "The Ring Tempts You",
            "The Ring // The Ring Tempts You",
        ],
    },
    Marker {
        words: &["the initiative"],
        helpers: &["Undercity // The Initiative", "The Initiative // Undercity"],
    },
    Marker {
        words: &["venture into the dungeon"],
        helpers: &[
            "Lost Mine of Phandelver",
            "Dungeon of the Mad Mage",
            "Tomb of Annihilation",
        ],
    },
    Marker {
        words: &["city's blessing"],
        helpers: &["City's Blessing"],
    },
    Marker {
        words: &[
            "daybound",
            "nightbound",
            "it becomes day",
            "it becomes night",
        ],
        helpers: &["Day // Night"],
    },
    Marker {
        words: &["start your engines!"],
        helpers: &["Start Your Engines! // Max Speed"],
    },
];

/// The words only the set checklists' text carries (`You can mark this card to represent a
/// double-faced card in your library`) — the one `Card` helper the reader chose to leave out.
const CHECKLIST_WORDS: &str = "this card to represent ";

/// The three words `deck_tokens.state` may hold, in the order the DDL's `CHECK` spells them.
///
/// * `auto` — the row exists only to carry a legacy quantity for a token the deck derives anyway.
/// * `hidden` — the reader dismissed it, on a build before user schema v55. **Nothing here writes
///   it any more**: the dismiss went with the token-improvements spec §3.3, and [`retire_hidden`]
///   turns every one back into an ordinary token at launch. It stays in the `CHECK` because a
///   peer on an older build can still write it and an old undo step can still restore it, and
///   every reader treats it as not hidden until the next launch retires it.
/// * `manual` — the reader's own: a token added by hand, drawn in each list that holds an entry
///   of it whether or not anything derives it — **or one the reader had copies of when the card
///   that made it was cut**, which [`reconcile_in`] keeps and turns `manual` (issue #671).
///   [`reconcile_in`] never takes a manual token's entries — no card made it, or the reader kept
///   it, so no cut can unmake it.
///
/// A constant here as well as a `CHECK` in the table, so the words this module writes are named
/// rather than respelled. `every_state_word_is_one_the_table_accepts` walks every word in this
/// constant through the real table, which is what holds the two spellings together. (It also
/// turned an unknown word into a sentence while `deck_token_state` let a command parameter reach
/// this column; v55 retired that command, and no parameter reaches it now.)
const TOKEN_STATES: [&str; 3] = ["auto", "hidden", "manual"];

/// The column's own DEFAULT, by index rather than by spelling — [`crate::deck`]'s `LIVE`
/// arrangement, so the two cannot drift.
const AUTO_STATE: &str = TOKEN_STATES[0];

/// `TOKEN_STATES[1]`, by index for [`AUTO_STATE`]'s reason.
const HIDDEN_STATE: &str = TOKEN_STATES[1];

/// `TOKEN_STATES[2]`, by index for [`AUTO_STATE`]'s reason.
const MANUAL_STATE: &str = TOKEN_STATES[2];

/// What a write says when the printing it was handed is not in the corpus.
///
/// A sentence rather than silence, because this arrives from a printings grid the reader was just
/// looking at: an id that has gone since means the corpus moved under them, and a press that
/// reported success and stored nothing would be worse.
pub const NO_SUCH_PRINTING: &str = "That printing is not in the card database any more.";

/// What an added printing says when it is not a token or an emblem at all — Lightning Bolt handed
/// to the band's **Add printing**, which would otherwise be filed as a hand-added token and drawn
/// on the wall as one. `deck::add_card` and `collection_alloc::collection_to_deck` reroute only
/// what [`is_token_printing`] answers `true` for, and this refuses exactly the rest, so no real
/// add of a card can reach it; the Storybook fake refuses the same press in the same words.
pub const NOT_A_TOKEN: &str = "That card is not a token or an emblem.";

/// What a swap says when the printing it would swap onto is another card's —
/// `deck_swap_printing`'s different-oracle guard, one table over. A token's entries are
/// printings **of that token**, and filing a Soldier under a Treasure would draw a Soldier tile
/// the resolver groups as a Treasure.
pub const NOT_THIS_TOKEN: &str = "That printing is not one of this token's.";

/// What a stepper, a swap or a remove says when the entry it names is not in the list any more —
/// a stale editor, or another window that stepped it to nothing or removed it first.
pub const ENTRY_GONE: &str = "That printing of the token is not in this list any more.";

/// What a write naming the implicit entry says when the token has none — the list derives nothing
/// for it. A hand-added token has no implicit entry in any list: it is drawn only where it holds
/// an entry, so a page naming its implicit one is naming a tile that is not there.
pub const TOKEN_GONE: &str = "That token is not in this list any more.";

/// A deck card that makes a token — the answer to *why is this here*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSource {
    pub card_id: String,
    pub name: String,
}

/// One entry's address on the wire: a printing and a finish, which is the grain within one
/// token of one list. What a stepper and the printing picker both name.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEntryKey {
    pub card_id: String,
    pub finish: String,
}

/// One **entry** of one token or emblem a deck's list needs — or its implicit entry.
///
/// **One row per entry, not per token**, since user schema v52: a token with three printings in
/// the list is three rows sharing every field above [`Self::card_id`], and a token with none is
/// one row with [`Self::implicit`] set. What makes a token's rows one token on the wall is
/// `oracle_id`; `deckTokens.ts` draws the conclusion.
///
/// `PartialEq` and not `Eq` since [`Self::unit_price`] made it carry an `f64`.
#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// The printing the resolver names, deterministically. Never blank for a derived row. An
    /// implicit entry draws this printing; a stored entry may draw any printing of the token.
    pub default_card_id: String,
    /// The deck cards that make it. Empty for a `manual` token nothing derives.
    pub sources: Vec<TokenSource>,
    /// Whether this list's cards make the token. `false` is a token the reader added by hand —
    /// the one the page marks as not made by the deck (the token-improvements spec §3.5).
    pub derived: bool,
    /// The token's **effective** state — `auto`, `hidden` or `manual` — shared by both lists and
    /// by every entry of the token. `auto` where `deck_tokens` holds no row, which is the
    /// ordinary case: that table stores only deviations. **Whether the deck makes the token is
    /// [`Self::derived`] and never this**: a derived token can be `manual`. `hidden` is a
    /// pre-v55 dismissal the launch has not retired yet, and nothing draws it any differently.
    pub state: String,
    /// **This entry's printing.** An implicit entry's is [`Self::default_card_id`].
    pub card_id: String,
    /// This entry's finish — `nonfoil`, `foil` or `etched`, never absent. An implicit entry's is
    /// its printing's default finish ([`default_finish`]): `nonfoil` where the printing is sold
    /// that way, its first sold finish otherwise.
    pub finish: String,
    /// This entry's **effective** quantity. A stored entry's is its row's, and may be `0` — the
    /// last entry of a token stepped to nothing stays at nothing (rule 3). An implicit entry's is
    /// `deck_tokens.quantity ?? 0` ([`implicit_quantity`]).
    pub quantity: i64,
    /// Whether this is the implicit entry of a token with no entries in this list — the one the
    /// first write to it materialises (rule 2).
    pub implicit: bool,
    /// This entry's printing's set code — [`Self::card_id`]'s printing and never the resolver's,
    /// which is the whole of [`drawn_for`]. **All six chin fields below are `None` together when
    /// the printing has left the corpus.**
    pub set_code: Option<String>,
    /// This entry's printing's collector number.
    pub collector_number: Option<String>,
    /// This entry's printing's set name.
    pub set_name: Option<String>,
    /// This entry's printing's rarity, Scryfall's word (`common`, `rare`, …).
    pub rarity: Option<String>,
    /// This entry's printing's finishes, as the JSON text `cards.finishes` holds
    /// (`["nonfoil","foil"]`) — `packages/ui/lib/finish.ts`' `parseFinishes` input, not a second shape.
    /// What the picker offers; [`Self::finish`] is what this entry is.
    pub finishes: Option<String>,
    /// What one copy of this entry costs in the asked marketplace **at [`Self::finish`]**
    /// ([`printing_price`]), or `None` where that marketplace has no figure — never `0`, which a
    /// pile heading's sum would count as a free card.
    pub unit_price: Option<f64>,
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
    /// The three chin fields `set_code` and `collector_number` do not already carry — read with
    /// the row, so an implicit entry costs no second query for them.
    set_name: Option<String>,
    rarity: Option<String>,
    finishes: Option<String>,
}

/// The columns [`Printing`] reads, in its own order.
///
/// **Every display column the wire shape needs, not just the layout the filter reads.** The row is
/// fetched once to answer the `emblem` half of the keep rule and once more would be a second query
/// per `all_parts` entry for fields that arrived with the first.
///
/// [`printing_from`] reads by position, so a column added anywhere but the end shifts every later
/// index into a field of the same SQLite type, silently — [`crate::deck`]'s `deck_row` rule.
const PRINTING_COLUMNS: &str = "id, oracle_id, name, type_line, layout, power, toughness, colors,
     oracle_text, released_at, set_code, collector_number, set_name, rarity, finishes";

/// A [`Printing`], or `None` when the row carries no `oracle_id` and so cannot be grained.
///
/// The column is NULLABLE and **0 of 3 245 token, emblem and double-faced-token rows are missing
/// one** (debug corpus, 2026-09-07) — so this is a fence around a case that does not currently
/// occur, written the way [`crate::card::list_printings`] fences the blank.
fn printing_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Printing>> {
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
        // 12, 13 and 14 — three `TEXT` columns in a row, so a crossed pair types out perfectly
        // and draws a rarity where the set name belongs. Only the position tells them apart.
        set_name: r.get(12)?,
        rarity: r.get(13)?,
        finishes: r.get(14)?,
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

/// One token a list derives: the printing the resolver names, and the deck cards that make it.
struct Derived {
    best: Printing,
    sources: Vec<TokenSource>,
}

/// Everything one list of one deck derives, keyed on the token's `oracle_id`.
struct Derivation {
    tokens: HashMap<String, Derived>,
    /// **Whether any maker in the list could not be read** — a printing that has left the
    /// corpus, a `raw` that will not inflate or parse, an `all_parts` that is not an array, or an
    /// entry naming a printing this corpus does not hold.
    ///
    /// The resolver ignores it: every failure there is an empty answer, and a wall short of one
    /// token is better than a deck that will not open. **[`reconcile_in`] does not**, and the
    /// difference is that the reconcile *deletes*. A list whose makers cannot all be read cannot
    /// prove a token is no longer made, and the one population where every maker is unreadable
    /// is the one that would lose everything: a device paired before its first corpus download
    /// derives nothing from anything, and a reconcile there — its deletions captured and pushed —
    /// would wipe the reader's token printings on every device in the group.
    unreadable: bool,
}

/// The stored state for one token: `(card_id, quantity, state)` — the first two legacy since
/// v52, read only as an implicit entry's quantity.
type Override = (Option<String>, Option<i64>, String);

/// One stored entry, as the resolver reads it: `(card_id, finish, quantity)`.
type StoredEntry = (String, String, i64);

/// Every token one list of one deck derives, with the printing the resolver names for each.
///
/// Five things about the walk, and the fourth — which is a rule that is deliberately *absent* —
/// is the one to read twice. A sixth sits beside them: **a maker's rules text is read for
/// [`MARKERS`]** — `you become the monarch`, `the Ring tempts you` — and each marker it names
/// credits its helper card exactly as an `all_parts` token would be credited, because a helper is
/// neither a `token` component nor an `emblem` layout and the keep rule never sees one (#670).
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
///    can draw or pick art for is not a row worth having — though it does mark the list
///    [`Derivation::unreadable`], because the reconcile cannot tell which token it was.
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
/// The printing named for each is the most-referenced one, ties broken by [`tie_break`] — the
/// implicit entry's printing, and what a write materialises.
fn derive(conn: &Connection, deck_id: i64, variant: &str) -> Result<Derivation, String> {
    let makers = deck_printings(conn, deck_id, variant)?;

    let mut printings = conn
        .prepare(&format!(
            "SELECT {PRINTING_COLUMNS} FROM cards WHERE id = ?1"
        ))
        .map_err(|e| e.to_string())?;
    let mut blobs = conn
        .prepare("SELECT name, CAST(raw AS BLOB) FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    // One lookup per distinct referenced printing, however many of the deck's cards name it.
    let mut cache: HashMap<String, Option<Printing>> = HashMap::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    let mut unreadable = false;
    // One lookup per marker a maker names, however many of the deck's cards name it — and none
    // for a deck that names none, which is most of them.
    let mut marker_helpers: HashMap<usize, Vec<Printing>> = HashMap::new();

    for maker in &makers {
        let row: Option<(String, Option<Vec<u8>>)> = blobs
            .query_row(params![maker], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        // A deck card whose printing has left the corpus is flagged elsewhere and makes nothing
        // here: there is no blob to read.
        let Some((own_name, stored)) = row else {
            unreadable = true;
            continue;
        };
        let Some(json) = stored.as_deref().and_then(crate::card_row::raw_json) else {
            unreadable = true;
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
            unreadable = true;
            continue;
        };
        // The markers first, because they are read off the text and not off `all_parts`: a card
        // with no `all_parts` at all can still make its controller the monarch.
        let text = rules_text(&value);
        for (index, marker) in MARKERS.iter().enumerate() {
            if !marker.words.iter().any(|word| text.contains(word)) {
                continue;
            }
            let helpers = match marker_helpers.entry(index) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(marker_printings(conn, marker.helpers)?)
                }
            };
            for helper in helpers.iter() {
                credit(&mut groups, helper, maker, &own_name);
            }
        }

        // No `all_parts` at all is a card that makes nothing more — read, and answered. One that
        // is not an array is a blob this build cannot read.
        let parts = match value.get("all_parts") {
            None => continue,
            Some(parts) => match parts.as_array() {
                Some(parts) => parts,
                None => {
                    unreadable = true;
                    continue;
                }
            },
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
                // Dropped from the answer, and the list marked unsure **whatever the component
                // said**: a `token` entry names a token this corpus cannot show, and a
                // `combo_piece` may be an emblem — which only the missing row's layout would say.
                unreadable = true;
                continue;
            };
            if !TOKEN_COMPONENTS.contains(&component.as_str())
                && !EXTRA_LAYOUTS.contains(&target.layout.as_str())
            {
                continue;
            }
            credit(&mut groups, target, maker, &own_name);
        }
    }

    let tokens = groups
        .into_iter()
        .map(|(oracle_id, group)| {
            // Most-referenced first, ties broken by the printings tail. `sort_by` rather than
            // `max_by`, because `max_by` answers the *last* of an equal run and the tie-break has
            // to be what chooses — across 40 Treasure makers, 12 distinct Treasure printings were
            // referenced, so two makers pointing at two printings is the common case rather than
            // a corner one.
            let mut referenced: Vec<(Printing, i64)> = group.referenced.into_values().collect();
            referenced.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| tie_break(&a.0, &b.0)));
            let best = referenced.swap_remove(0).0;
            let mut sources = group.sources;
            sources.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.card_id.cmp(&b.card_id)));
            (oracle_id, Derived { best, sources })
        })
        .collect();
    Ok(Derivation { tokens, unreadable })
}

/// One reference from `maker` to `target`: a count against that printing, and the maker among the
/// token's sources once however many times it names it — an `all_parts` entry and a [`Marker`]
/// naming one token are one source, not two.
fn credit(groups: &mut HashMap<String, Group>, target: &Printing, maker: &str, own_name: &str) {
    let group = groups.entry(target.oracle_id.clone()).or_default();
    group
        .referenced
        .entry(target.id.clone())
        .or_insert_with(|| (target.clone(), 0))
        .1 += 1;
    if group.counted.insert(maker.to_owned()) {
        group.sources.push(TokenSource {
            card_id: maker.to_owned(),
            name: own_name.to_owned(),
        });
    }
}

/// A maker's rules text as [`MARKERS`] are matched against it: the card's own `oracle_text` and
/// every face's, lower-cased, with the curly apostrophe folded to the straight one Scryfall
/// writes. **Off the blob and not the `oracle_text` column**, because a two-faced card keeps
/// its text on its faces and the column is NULL for one — a daybound werewolf, most of all.
fn rules_text(card: &Value) -> String {
    let mut text = String::new();
    let faces = card
        .get("card_faces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for body in std::iter::once(card).chain(faces) {
        if let Some(t) = body.get("oracle_text").and_then(Value::as_str) {
            text.push_str(t);
            text.push('\n');
        }
    }
    text.to_lowercase().replace('\u{2019}', "'")
}

/// The newest printing of each helper card `names` spells, one per `oracle_id` — what a
/// [`Marker`] credits. **Paper, a [`TOKEN_LAYOUTS`] row, and outside the
/// [`OTHER_GAME_SET_TYPES`]**, which is [`is_listed_token`]'s helper arm: a World Championships
/// deck's copy of a helper is not the art a reader expects, and a name that somehow landed on a
/// real card would otherwise be filed on the token wall.
///
/// `name IN (…)` rides `idx_cards_name`, so the cost is a handful of index probes rather than the
/// full scan a face-name match would pay. Empty when no name resolves — the corpus has not
/// downloaded yet, or Scryfall spells it otherwise — never an error for that.
fn marker_printings(conn: &Connection, names: &[&str]) -> Result<Vec<Printing>, String> {
    let marks = vec!["?"; names.len()].join(", ");
    let sql = format!(
        "SELECT {PRINTING_COLUMNS} FROM cards c
          WHERE c.name IN ({marks})
            AND c.is_paper = 1
            AND c.layout IN ({layouts})
            AND NOT EXISTS
                (SELECT 1 FROM sets s
                  WHERE s.code = c.set_code AND s.set_type IN ({other_games}))
          ORDER BY c.oracle_id, c.released_at DESC, c.set_code, c.collector_number, c.id",
        layouts = sql_words(&TOKEN_LAYOUTS),
        other_games = sql_words(&OTHER_GAME_SET_TYPES),
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(names), printing_from)
        .map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        // The first of each oracle id is its newest, by the `ORDER BY` — [`tie_break`] in SQL.
        if let Some(p) = row.map_err(|e| e.to_string())? {
            if seen.insert(p.oracle_id.clone()) {
                out.push(p);
            }
        }
    }
    Ok(out)
}

/// Every entry of every token one list of one deck needs, with the token's state joined on —
/// **one row per stored entry, or one implicit row for a token with none** (spec §4.2 rule 1).
///
/// **Every way this can fail is `Ok(vec![])`, never an `Err`** — an unknown deck, an unknown
/// printing, a `raw` that will not inflate or will not parse, a missing `all_parts`, an
/// `all_parts` that is not an array. [`crate::card::meld_parts`] argues this at `card.rs:626` for
/// a control most cards do not have; here it is a whole area most decks use lightly, and a deck
/// that would not open over it is a worse answer than a wall that is empty. [`derive`] is the
/// walk, and its doc carries the five things about it.
///
/// **Which tokens are on the wall**: every token the list derives, and every token it does not
/// whose state is `manual` — or a pre-v55 `hidden` the launch has not retired yet — **and that
/// holds an entry in this list**. A hand-added token draws its entries and never an implicit one
/// (the token-improvements spec §3.4), so a Soldier added to the live list is not on the plan's
/// wall. An `auto` token with entries that the list does not derive — its maker was cut through a
/// write the reconcile could not reach yet — draws nothing, and [`reconcile_in`] will settle it at
/// the next write: its entries at zero deleted, and the token kept as `manual` if any has copies.
///
/// Order is `(name, oracle_id)`, derived tokens first and hand-added ones after, and within one
/// token its entries by `(card_id, finish)`. Which order the wall is actually in is
/// TypeScript's — emblems last, then by name, then a token's entries by set and number — and
/// **its sort is stable**, so an unordered answer here would make two `Wurm` tiles swap places
/// between opens.
///
/// `market` prices each entry at its own finish — see this module's *The chin and the price*.
pub fn deck_token_rows(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    market: Marketplace,
) -> Result<Vec<DeckTokenRow>, String> {
    let derivation = derive(conn, deck_id, variant)?;
    let overrides = stored_overrides(conn, deck_id)?;
    let entries = stored_entries(conn, deck_id, variant)?;

    let mut derived: Vec<(String, Derived)> = derivation.tokens.into_iter().collect();
    derived.sort_by(|a, b| {
        a.1.best
            .name
            .cmp(&b.1.best.name)
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut out: Vec<DeckTokenRow> = Vec::with_capacity(derived.len());
    let on_wall: HashSet<String> = derived.iter().map(|(o, _)| o.clone()).collect();
    for (oracle_id, token) in derived {
        push_rows(
            conn,
            &mut out,
            Token {
                printing: &token.best,
                sources: token.sources,
                derived: true,
                stored: overrides.get(&oracle_id),
                entries: entries.get(&oracle_id).map(Vec::as_slice),
            },
            market,
        )?;
    }

    // The hand-added tail: a token the list derives nothing for is on the wall because the reader
    // said so — **in a list that holds an entry of it, and only there**. There is no implicit row
    // here: an implicit entry is the deck's default for a token its cards make, and nothing makes
    // this one, so a list with none of its entries has nothing to draw.
    // **Any state but `auto` says so**: `manual`, and a `hidden` that arrived by sync after the
    // launch retired this device's own — a hand-added token dismissed on an older peer, which must
    // draw like any other until the next launch (Review Focus 1). An `auto` row with entries is a
    // token whose maker was cut, which the reconcile settles — zeros deleted, copies kept `manual`.
    // Resolved by `oracle_id`, so a token whose every entry names a printing that has left the
    // corpus still draws — `default_card_id` is answerable without them.
    let mut added: Vec<(&String, Printing)> = Vec::new();
    for (oracle_id, stored) in &overrides {
        if stored.2 == AUTO_STATE || on_wall.contains(oracle_id) {
            continue;
        }
        if entries.get(oracle_id).is_none_or(Vec::is_empty) {
            continue;
        }
        if let Some(printing) = newest_printing(conn, oracle_id)? {
            added.push((oracle_id, printing));
        }
    }
    added.sort_by(|a, b| a.1.name.cmp(&b.1.name).then_with(|| a.0.cmp(b.0)));
    for (oracle_id, printing) in &added {
        push_rows(
            conn,
            &mut out,
            Token {
                printing,
                sources: Vec::new(),
                derived: false,
                stored: overrides.get(*oracle_id),
                entries: entries.get(*oracle_id).map(Vec::as_slice),
            },
            market,
        )?;
    }
    Ok(out)
}

/// One token on the wall, as [`push_rows`] needs it.
struct Token<'a> {
    /// The printing the resolver names — the token's display fields and its implicit entry.
    printing: &'a Printing,
    sources: Vec<TokenSource>,
    derived: bool,
    stored: Option<&'a Override>,
    /// This list's stored entries of it, `None` or empty for an implicit token.
    entries: Option<&'a [StoredEntry]>,
}

/// A token's rows: one per stored entry, or its one implicit entry.
fn push_rows(
    conn: &Connection,
    out: &mut Vec<DeckTokenRow>,
    token: Token<'_>,
    market: Marketplace,
) -> Result<(), String> {
    let state = token.stored.map_or(AUTO_STATE, |s| s.2.as_str()).to_owned();
    match token.entries.filter(|e| !e.is_empty()) {
        Some(entries) => {
            for (card_id, finish, quantity) in entries {
                let drawn = drawn_for(conn, token.printing, card_id, finish, market)?;
                out.push(row_of(
                    &token,
                    drawn,
                    state.clone(),
                    card_id.clone(),
                    finish.clone(),
                    *quantity,
                    false,
                ));
            }
        }
        None => {
            let finish = default_finish(token.printing.finishes.as_deref()).to_owned();
            let drawn = drawn_for(conn, token.printing, &token.printing.id, &finish, market)?;
            out.push(row_of(
                &token,
                drawn,
                state,
                token.printing.id.clone(),
                finish,
                implicit_quantity(token.stored.and_then(|s| s.1)),
                true,
            ));
        }
    }
    Ok(())
}

/// An implicit entry's quantity: the legacy `deck_tokens.quantity`, or **none**.
///
/// **Zero since user schema v55, and one until then** (the token-improvements spec §3.1). A token
/// is something the reader starts to use — a Treasure the deck *can* make is not a Treasure on
/// the table — so an untouched one counts nothing, stays out of the stacks, and the first `+`
/// materialises it at one. Nothing stored changes with it: an untouched token was never written,
/// so it simply reads zero from this build on, and a peer still on v54 goes on drawing it at one —
/// a difference in what two builds draw, never in what they store.
///
/// `??` and never "truthy": a legacy count a reader set before v52 is still theirs, a `0`
/// included.
fn implicit_quantity(legacy: Option<i64>) -> i64 {
    legacy.unwrap_or(0)
}

/// A string field, if present and actually a string — [`crate::card`]'s helper, one file over.
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// One wire row: the token's own fields off the printing the resolver named, and the entry's
/// printing, finish, quantity and drawing beside them.
///
/// `drawn` is [`drawn_for`]'s answer for the entry's printing and is passed in rather than taken
/// off the token's printing, because the two disagree for exactly the entries the reader picked.
fn row_of(
    token: &Token<'_>,
    drawn: Drawn,
    state: String,
    card_id: String,
    finish: String,
    quantity: i64,
    implicit: bool,
) -> DeckTokenRow {
    let printing = token.printing;
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
        sources: token.sources.clone(),
        derived: token.derived,
        state,
        card_id,
        finish,
        quantity,
        implicit,
        set_code: drawn.set_code,
        collector_number: drawn.collector_number,
        set_name: drawn.set_name,
        rarity: drawn.rarity,
        finishes: drawn.finishes,
        unit_price: drawn.unit_price,
    }
}

/// What a tile draws beneath the printing it **addresses** — the chin and the price. All `None`
/// ([`Default`]) for a printing that has left the corpus.
#[derive(Debug, Default)]
struct Drawn {
    set_code: Option<String>,
    collector_number: Option<String>,
    set_name: Option<String>,
    rarity: Option<String>,
    finishes: Option<String>,
    unit_price: Option<f64>,
}

/// What an entry's tile draws: `card_id`'s chin and price, the price at `finish`.
///
/// **The entry's printing and never the resolver's**, and getting it the other way round is a
/// *wrong* chin rather than a missing one — the tile draws `card_id`'s art, so the chin under it
/// would name a set the art is not from, and the pile heading would sum the wrong printing's price.
///
/// The extra row read is skipped whenever the entry *is* the resolver's printing, which is every
/// implicit entry; the price is one read either way. **A printing that has left the corpus
/// answers all `None` rather than falling back to the resolver's**: the tile is addressing that
/// printing, so a chin or a price from a different one would be this function inventing a card.
fn drawn_for(
    conn: &Connection,
    printing: &Printing,
    card_id: &str,
    finish: &str,
    market: Marketplace,
) -> Result<Drawn, String> {
    if card_id != printing.id {
        return picked_printing(conn, card_id, finish, market);
    }
    Ok(Drawn {
        set_code: Some(printing.set_code.clone()),
        collector_number: Some(printing.collector_number.clone()),
        set_name: printing.set_name.clone(),
        rarity: printing.rarity.clone(),
        finishes: printing.finishes.clone(),
        unit_price: printing_price(conn, &printing.id, finish, market)?,
    })
}

/// One picked printing's chin, and then its price — the columns a tile needs rather than a second
/// whole [`Printing`], and no `oracle_id` fence, because the pick is addressed by id and was never
/// grained.
fn picked_printing(
    conn: &Connection,
    card_id: &str,
    finish: &str,
    market: Marketplace,
) -> Result<Drawn, String> {
    let found = conn
        .query_row(
            "SELECT set_code, collector_number, set_name, rarity, finishes
               FROM cards WHERE id = ?1",
            params![card_id],
            |r| {
                Ok(Drawn {
                    set_code: r.get(0)?,
                    collector_number: r.get(1)?,
                    set_name: r.get(2)?,
                    rarity: r.get(3)?,
                    finishes: r.get(4)?,
                    unit_price: None,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mut drawn) = found else {
        return Ok(Drawn::default());
    };
    drawn.unit_price = printing_price(conn, card_id, finish, market)?;
    Ok(drawn)
}

/// One printing's price in `market` **at one finish** — [`crate::sorting::price_expr`], the
/// collection's own lookup, with **no fallback of any kind**. `None` for unpriced, and for a
/// printing that is not there.
///
/// **Not the `nonfoil → foil → etched` chain any more**, which is what this read until v52: then
/// a token had no finish of its own and was priced as a deck row naming none is. An entry always
/// names one, and a chain would quote a nonfoil Treasure at its foil rate whenever the nonfoil is
/// unpriced — the deck's own rule for a row that *says* its finish, `row_price_expr`'s named arm.
///
/// The finish is **bound**, never interpolated: it is the expression `price_expr` compares
/// against its three words, and a parameter is exactly as good an expression as a literal.
fn printing_price(
    conn: &Connection,
    card_id: &str,
    finish: &str,
    market: Marketplace,
) -> Result<Option<f64>, String> {
    conn.query_row(
        &format!(
            "SELECT {} FROM cards c WHERE c.id = ?1",
            crate::sorting::price_expr(market, "?2")
        ),
        params![card_id, finish],
        |r| r.get::<_, Option<f64>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// The finishes a printing is sold in, in [`crate::schema::FINISHES`]' order, out of the JSON
/// text `cards.finishes` holds. Empty for a column that is NULL, unparseable or names nothing
/// this app knows — which every reader here takes as "no opinion" rather than "sold in nothing".
fn offered(finishes: Option<&str>) -> Vec<&'static str> {
    let listed: Vec<String> = finishes
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    crate::schema::FINISHES
        .into_iter()
        .filter(|f| listed.iter().any(|l| l == f))
        .collect()
}

/// A printing's default finish: `nonfoil` where it is sold that way, else the first finish it is
/// sold in (its **sole** finish, for the 13 515 foil-only and 892 etched-only printings), and
/// `nonfoil` where the column says nothing.
///
/// What an implicit entry is drawn in, what rule 2 materialises, what an add naming no finish
/// files, and what [`repair_entry_finishes`] moves an unsold finish to. One function, because the
/// four must not disagree.
fn default_finish(finishes: Option<&str>) -> &'static str {
    offered(finishes)
        .first()
        .copied()
        .unwrap_or(crate::schema::FINISHES[0])
}

/// The finish a write files: the one asked for, fenced, or the printing's default.
///
/// **An unknown word and a finish the printing is not sold in are both refused**, in the
/// collection's sentence and in `deck::FINISH_NOT_SOLD` — the picker only ever offers what is
/// sold, so a request for anything else is a caller with a bug or a corpus that moved under the
/// reader, and quietly filing a different finish would hide either.
fn entry_finish(printing: &Printing, asked: Option<&str>) -> Result<String, String> {
    let Some(asked) = asked else {
        return Ok(default_finish(printing.finishes.as_deref()).to_owned());
    };
    let asked = crate::collection::valid_finish(asked)?;
    let sold = offered(printing.finishes.as_deref());
    if !sold.is_empty() && !sold.contains(&asked) {
        return Err(crate::deck::FINISH_NOT_SOLD.to_owned());
    }
    Ok(asked.to_owned())
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

/// Every stored token state for one deck, keyed on the grain's second term — the state, and the
/// legacy quantity an implicit entry still reads.
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

/// Every stored entry of one list of one deck, grouped by token — `(card_id, finish, quantity)`
/// in `(card_id, finish)` order, so a token's rows come back in one order on every open.
fn stored_entries(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<HashMap<String, Vec<StoredEntry>>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT oracle_id, card_id, finish, quantity FROM deck_token_printings
              WHERE deck_id = ?1 AND variant = ?2
              ORDER BY oracle_id, card_id, finish",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get(1)?, r.get(2)?, r.get::<_, i64>(3)?),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: HashMap<String, Vec<StoredEntry>> = HashMap::new();
    for row in rows {
        let (oracle_id, entry) = row.map_err(|e| e.to_string())?;
        out.entry(oracle_id).or_default().push(entry);
    }
    Ok(out)
}

/// The printing of one oracle card the tie-break names first — [`tie_break`] as SQL, so a hand
/// row and a derived one cannot disagree about which art is the default.
fn newest_printing(conn: &Connection, oracle_id: &str) -> Result<Option<Printing>, String> {
    conn.query_row(
        &format!(
            "SELECT {PRINTING_COLUMNS} FROM cards WHERE oracle_id = ?1
              ORDER BY released_at DESC, set_code ASC, collector_number ASC, id ASC
              LIMIT 1"
        ),
        params![oracle_id],
        printing_from,
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// One printing by id, or [`NO_SUCH_PRINTING`] — for a write, which is addressed by a printing
/// the reader picked and has to learn its token from it.
fn printing_by_id(conn: &Connection, card_id: &str) -> Result<Printing, String> {
    conn.query_row(
        &format!("SELECT {PRINTING_COLUMNS} FROM cards WHERE id = ?1"),
        params![card_id],
        printing_from,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .flatten()
    .ok_or_else(|| NO_SUCH_PRINTING.to_owned())
}

/// Whether a layout is a token's or an emblem's **on its own** — [`TOKEN_LAYOUTS`], the first half
/// of [`is_token_printing`].
///
/// **Not the routing question, and private so that nothing outside this module can ask it as
/// one.** A caller deciding whether a printing is filed as a token asks [`is_token_printing`] (or
/// [`printing_is_token`] over a row): a layout-only test answers `false` for the six `flip` and
/// `reversible_card` tokens, and `deck::add_card` routed on exactly that until its call site moved
/// to [`printing_is_token`] — writing those six as deck cards. `deckTokens.ts`' `isTokenLayout`
/// is the TypeScript twin, and it draws a wall of rows this crate already chose.
fn is_token_layout(layout: &str) -> bool {
    TOKEN_LAYOUTS.contains(&layout)
}

/// **Whether a printing is a token or an emblem — the question both add paths route on**, and the
/// one [`add_printing_in`] refuses everything else by ([`NOT_A_TOKEN`]).
///
/// Two halves:
///
/// 1. **The layout alone**, for [`TOKEN_LAYOUTS`] — `token`, `double_faced_token`, `emblem`.
/// 2. **The type line, for [`TWO_SIDED_LAYOUTS`]** — a `flip` or `reversible_card` printing is a
///    token when its type line, **or any face of it**, begins with `Token` or `Emblem`. The corpus
///    stores a two-faced printing's line as its faces joined by ` // `
///    (`Token Enchantment — Aura Role // Token Enchantment — Aura Role`), so the faces are the
///    ` // ` segments and no JSON is parsed.
///
/// **Why the type line and not `legal_mask`, the `faces` column or `all_parts`**, measured over
/// the 127 `flip` and `reversible_card` rows on the debug corpus, 2026-09-26: all 7 whose top-level
/// type line begins `Token` also say it on every face in `faces`, and 0 rows say it on a face and
/// not at the top — so the stored line is exactly as good as the faces and costs no parse. The six
/// token targets of the keep rule's 78 entries are all among those 7. `legal_mask = 0` would also
/// catch them, but it catches a non-token `flip` besides (one row is `legal_mask = 0` with no
/// `Token` anywhere), and "legal nowhere" is not "a token". Scryfall writes the `Token` supertype
/// first (`Token Legendary Artifact Creature — Construct`), which is why a prefix is enough.
///
/// Any other layout is never a token, whatever its line says. `deckTokens.ts`' `isTokenLayout`
/// answers only the first half, for drawing a wall whose rows this crate already chose.
pub fn is_token_printing(layout: &str, type_line: Option<&str>) -> bool {
    if is_token_layout(layout) {
        return true;
    }
    if !TWO_SIDED_LAYOUTS.contains(&layout) {
        return false;
    }
    line_names_a_token(type_line)
}

/// Whether a type line — **or any ` // ` face of it** — begins `Token` or `Emblem`
/// ([`TOKEN_LINE_WORDS`]): [`is_token_printing`]'s second half, and the whole of what
/// [`is_listed_token`] adds to the layout.
fn line_names_a_token(type_line: Option<&str>) -> bool {
    type_line.is_some_and(|line| {
        line.split(" // ")
            .any(|face| TOKEN_LINE_WORDS.iter().any(|word| face.starts_with(word)))
    })
}

/// **Whether All tokens lists a printing: a real token or emblem, or a game helper** — narrower
/// than [`is_token_printing`], and on purpose. Two arms:
///
/// 1. **A token or an emblem** — a layout [`is_token_printing`] trusts on its own
///    ([`TOKEN_LAYOUTS`]) or a two-sided one ([`TWO_SIDED_LAYOUTS`]), **and** a type line naming a
///    `Token` or `Emblem` face, whatever the layout. Every token and emblem the keep rule can
///    derive has one, the six two-sided Role tokens and Mechtitan included.
/// 2. **A game helper** ([`is_game_helper`]) — a card a deck brings to the table during an
///    ordinary game: The Monarch, The Initiative, Day // Night, City's Blessing, Energy Reserve,
///    Radiation, the face-down Manifest and Morph cards — and since issue #670 the dungeons a
///    venturing deck brings, by a face beginning [`DUNGEON_FACE`]. The reader's rule
///    (2026-09-28): keep those, leave out advertising, checklists, standalone minigames and other
///    games' cards, and keep anything in doubt — a list with one card too many costs a scroll, one
///    that hides a card the reader needs costs a card they cannot add.
///
/// **Why the layout alone is not enough.** Scryfall files every helper under `token` or
/// `double_faced_token` — measured on the debug corpus (`node:sqlite` over a copy, 2026-09-28),
/// 280 of the 3 303 paper printings the layout admits name no `Token` or `Emblem` face — and the
/// same layouts carry the World Championship decks' ads, bios and decklists, the set checklists,
/// the booster minigames, the Theros challenge decks' Minotaurs, Revelers and Hydra heads, and the
/// TMNT arena's bosses and events. The list went from 3 303 printings over 1 096 tokens (the layout
/// alone), to 3 023 over 911 (the first arm alone), to **3 110 over 940** with the helpers back.
///
/// **What separates the two sides is structural, not a list of names.** The other games' cards
/// sit in `memorabilia` and `minigame` sets ([`OTHER_GAME_SET_TYPES`]) — the TMNT arena is the
/// exception, a `token` set, and its `Boss`, `Event` and `Creature — Ninja` lines are neither a
/// helper face nor a face-down card. The best signal, which card names which in `all_parts`, is not
/// in a column: every helper this keeps but the Bounties, Punchcard, Companion and Enduring Story
/// is named by real cards (Morph by 402, The Monarch by 131), and nothing it leaves out is but the
/// checklists, which double-faced cards name as the proxy they are — left out by the reader's
/// choice ([`CHECKLIST_WORDS`]).
///
/// **Not the routing question.** [`is_token_printing`] still decides where an add of one of these
/// is filed — a helper picked here is added as a token entry, which is what it is on the table —
/// so that predicate is left as it is. `set_type` is the printing's `sets.set_type`, `None` where
/// the set is not in `sets`, which lists it.
pub fn is_listed_token(
    layout: &str,
    type_line: Option<&str>,
    oracle_text: Option<&str>,
    set_type: Option<&str>,
) -> bool {
    let token_shaped = is_token_layout(layout) || TWO_SIDED_LAYOUTS.contains(&layout);
    (token_shaped && line_names_a_token(type_line))
        || is_game_helper(layout, type_line, oracle_text, set_type)
}

/// [`is_listed_token`]'s second arm: a [`HELPER_LAYOUTS`] printing outside the
/// [`OTHER_GAME_SET_TYPES`], which has a [`HELPER_FACE`] (and is not a checklist,
/// [`CHECKLIST_WORDS`]), has a face beginning [`DUNGEON_FACE`], or is a face-down reminder
/// ([`FACE_DOWN_WORDS`]).
///
/// **Case-sensitive, as the SQL is** — `instr`, not `LIKE` — so
/// `token_printings_keeps_the_game_helpers_and_leaves_out_other_games` holds the two to one answer.
fn is_game_helper(
    layout: &str,
    type_line: Option<&str>,
    oracle_text: Option<&str>,
    set_type: Option<&str>,
) -> bool {
    if !HELPER_LAYOUTS.contains(&layout)
        || set_type.is_some_and(|t| OTHER_GAME_SET_TYPES.contains(&t))
    {
        return false;
    }
    let text = oracle_text.unwrap_or("");
    let faces = || type_line.unwrap_or("").split(" // ");
    let helper_face = faces().any(|f| f == HELPER_FACE);
    let dungeon = faces().any(|f| f.starts_with(DUNGEON_FACE));
    (helper_face && !text.contains(CHECKLIST_WORDS)) || dungeon || text.contains(FACE_DOWN_WORDS)
}

/// [`is_token_printing`] over the row `card_id` names — the one read the two add paths make.
///
/// `false` for a printing that is not in the corpus: that is not a token anybody can file, and the
/// caller's own lookup is what refuses it in words.
pub fn printing_is_token(conn: &Connection, card_id: &str) -> Result<bool, String> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT layout, type_line FROM cards WHERE id = ?1",
            params![card_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.is_some_and(|(layout, type_line)| {
        layout
            .as_deref()
            .is_some_and(|layout| is_token_printing(layout, type_line.as_deref()))
    }))
}

// ---------------------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------------------

/// Every entry of one token in one list, as a step carries them — in `(card_id, finish)` order,
/// so the before and after of one write compare as plain vectors.
fn entries_of(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
) -> Result<Vec<TokenEntryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT variant, oracle_id, card_id, finish, quantity FROM deck_token_printings
              WHERE deck_id = ?1 AND variant = ?2 AND oracle_id = ?3
              ORDER BY card_id, finish",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant, oracle_id], entry_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One `deck_token_printings` row in `variant, oracle_id, card_id, finish, quantity` order.
fn entry_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TokenEntryRow> {
    Ok(TokenEntryRow {
        variant: r.get(0)?,
        oracle_id: r.get(1)?,
        card_id: r.get(2)?,
        finish: r.get(3)?,
        quantity: r.get(4)?,
    })
}

/// One token's stored state, as a step carries it — `state: None` for no row.
fn state_of(conn: &Connection, deck_id: i64, oracle_id: &str) -> Result<TokenStateRow, String> {
    let row: Option<Override> = conn
        .query_row(
            "SELECT card_id, quantity, state FROM deck_tokens WHERE deck_id = ?1 AND oracle_id = ?2",
            params![deck_id, oracle_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match row {
        Some((card_id, quantity, state)) => TokenStateRow {
            oracle_id: oracle_id.to_owned(),
            card_id,
            quantity,
            state: Some(state),
        },
        None => TokenStateRow {
            oracle_id: oracle_id.to_owned(),
            card_id: None,
            quantity: None,
            state: None,
        },
    })
}

/// Write one token's state, keeping the legacy columns it carries — or **delete** the row when
/// the result would carry nothing.
///
/// **`state = 'auto'` with no legacy printing and no legacy quantity is not representable.** Such
/// a row carries no information, so this deletes instead of writing it — which keeps *the reader
/// has not deviated* one state rather than two that have to be kept in agreement. The legacy
/// columns are never written (spec §4.1); a row that carries one keeps it.
///
/// **`DECK_TOKEN_GRAIN` interpolated and never retyped**: an `ON CONFLICT` target that does not
/// match `idx_deck_tokens_grain` verbatim is a runtime error at the first write, not a compile
/// error, so the index and this statement read one constant.
fn write_state(tx: &Connection, deck_id: i64, oracle_id: &str, state: &str) -> Result<(), String> {
    if state == AUTO_STATE {
        tx.execute(
            "DELETE FROM deck_tokens
              WHERE deck_id = ?1 AND oracle_id = ?2 AND card_id IS NULL AND quantity IS NULL",
            params![deck_id, oracle_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE deck_tokens SET state = ?3, updated_at = unixepoch()
              WHERE deck_id = ?1 AND oracle_id = ?2 AND state <> ?3",
            params![deck_id, oracle_id, state],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    tx.execute(
        &format!(
            "INSERT INTO deck_tokens (deck_id, oracle_id, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             ON CONFLICT ({DECK_TOKEN_GRAIN}) DO UPDATE SET
                 state = excluded.state,
                 updated_at = unixepoch()"
        ),
        params![deck_id, oracle_id, state],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// **A dismissal's legacy count, cleared**: `deck_tokens.quantity` becomes `NULL` where the row
/// carries no pick and `0` where a v51 pick still waits for conversion — the reader's rule that a
/// dismissed token comes back **at zero**, which [`write_state`] alone breaks by keeping a legacy
/// count (a dismissed Treasure counted at 3 before v52 would come back at 3 in every list with no
/// entries of it). [`retire_hidden`]'s step 2, and every write that settles a stale `hidden` sooner
/// ([`settle_hidden`], [`add_printing_in`]) — so a dismissal comes back at zero whichever of them
/// reaches it first. Inside the caller's [`journal_in`] where there is one, whose state row carries
/// the quantity, so one Undo puts the count back with the word.
fn clear_legacy_count(tx: &Connection, deck_id: i64, oracle_id: &str) -> Result<(), String> {
    tx.execute(
        "UPDATE deck_tokens SET quantity = CASE WHEN card_id IS NULL THEN NULL ELSE 0 END
          WHERE deck_id = ?1 AND oracle_id = ?2",
        params![deck_id, oracle_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Write one entry at an absolute quantity, on [`DECK_TOKEN_PRINTING_GRAIN`] — interpolated for
/// [`write_state`]'s reason.
fn put_entry(tx: &Connection, deck_id: i64, row: &TokenEntryRow) -> Result<(), String> {
    tx.execute(
        &format!(
            "INSERT INTO deck_token_printings
                 (deck_id, variant, oracle_id, card_id, finish, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch())
             ON CONFLICT ({DECK_TOKEN_PRINTING_GRAIN}) DO UPDATE SET
                 quantity = excluded.quantity,
                 updated_at = unixepoch()"
        ),
        params![
            deck_id,
            row.variant,
            row.oracle_id,
            row.card_id,
            row.finish,
            row.quantity
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Delete one entry by grain.
fn drop_entry(tx: &Connection, deck_id: i64, row: &TokenEntryRow) -> Result<(), String> {
    tx.execute(
        "DELETE FROM deck_token_printings
          WHERE deck_id = ?1 AND variant = ?2 AND card_id = ?3 AND finish = ?4",
        params![deck_id, row.variant, row.card_id, row.finish],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The entry a token draws when it has none in this list — **rule 1**, computed exactly as
/// [`deck_token_rows`] computes it so that a write materialises the entry the reader was looking
/// at: the derived printing, in its [`default_finish`], at [`implicit_quantity`].
///
/// `None` for a token the list derives nothing for — `manual` included since user schema v55,
/// because a hand-added token is drawn only where it holds an entry and so has no implicit one to
/// materialise (the token-improvements spec §3.4). A `hidden` token that the list derives *has*
/// one, and is materialised like any other.
fn implicit_entry(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
) -> Result<Option<TokenEntryRow>, String> {
    let best = derived_printing(tx, deck_id, variant, oracle_id)?;
    implicit_of(tx, deck_id, variant, oracle_id, best)
}

/// The printing the list's derivation names for one token, or `None` where the list does not
/// make it — whether the token is derived, and its implicit printing when it is, in one walk.
fn derived_printing(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
) -> Result<Option<Printing>, String> {
    Ok(derive(tx, deck_id, variant)?
        .tokens
        .remove(oracle_id)
        .map(|d| d.best))
}

/// [`implicit_entry`] for a caller that has already derived the list — `best` is
/// [`derived_printing`]'s answer.
fn implicit_of(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
    best: Option<Printing>,
) -> Result<Option<TokenEntryRow>, String> {
    let Some(p) = best else {
        return Ok(None);
    };
    let legacy = state_of(tx, deck_id, oracle_id)?.quantity;
    Ok(Some(TokenEntryRow {
        variant: variant.to_owned(),
        oracle_id: oracle_id.to_owned(),
        finish: default_finish(p.finishes.as_deref()).to_owned(),
        card_id: p.id,
        quantity: implicit_quantity(legacy),
    }))
}

/// The entry a write names — `Some(key)` a stored entry, `None` the implicit one — and whether it
/// is implicit (not yet in the table). **Reads only**; the caller materialises.
///
/// `None` against a list that already holds entries of the token is a stale page (a second press
/// computed before the first one's answer came back): it names the implicit entry's grain, and
/// is answered by that stored entry where the list has one and refused where it does not — a
/// write to a printing the reader was not looking at would be worse than a sentence.
fn named_entry(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
    key: Option<&TokenEntryKey>,
) -> Result<(TokenEntryRow, bool), String> {
    let stored = entries_of(tx, deck_id, variant, oracle_id)?;
    let find = |card_id: &str, finish: &str| {
        stored
            .iter()
            .find(|e| e.card_id == card_id && e.finish == finish)
            .cloned()
    };
    match key {
        Some(key) => find(&key.card_id, &key.finish)
            .map(|e| (e, false))
            .ok_or_else(|| ENTRY_GONE.to_owned()),
        None => {
            let implicit = implicit_entry(tx, deck_id, variant, oracle_id)?
                .ok_or_else(|| TOKEN_GONE.to_owned())?;
            if stored.is_empty() {
                return Ok((implicit, true));
            }
            find(&implicit.card_id, &implicit.finish)
                .map(|e| (e, false))
                .ok_or_else(|| ENTRY_GONE.to_owned())
        }
    }
}

/// **A stale `hidden`, settled by the write that touches the token** — `auto` where this list
/// makes it, `manual` where it does not, the answer [`add_printing_in`] has always given, and **its
/// legacy count cleared** ([`clear_legacy_count`]) the way [`retire_hidden`] clears it, so the
/// other list's implicit entry comes back at zero rather than at the dismissal's old count (the
/// final review's deferred 1). The word is a pre-v55 dismissal nothing draws any more
/// ([`retire_hidden`] settles the rest at launch), and a step, a swap or a remove on the token is
/// the reader using it; leaving the word behind would leave a row every reader has to remember
/// means nothing.
///
/// Called inside the write's own [`journal_in`], so the state change is captured with the write
/// and rides its undo step: one Undo brings the count and the word back together. A token in any
/// other state is left alone, without a derivation.
fn settle_hidden(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
) -> Result<(), String> {
    if state_of(tx, deck_id, oracle_id)?.state.as_deref() != Some(HIDDEN_STATE) {
        return Ok(());
    }
    clear_legacy_count(tx, deck_id, oracle_id)?;
    let made = derived_printing(tx, deck_id, variant, oracle_id)?.is_some();
    let state = if made { AUTO_STATE } else { MANUAL_STATE };
    write_state(tx, deck_id, oracle_id, state)
}

/// What one token write did — the variable half of its history row.
struct Change {
    /// `quantity`, `swap`, `add` or `remove` — `auditText.ts`' arms. (`state` and `reset` were
    /// the other two until v55 retired their commands; rows already on disk still carry them.)
    action: &'static str,
    card_id: Option<String>,
    finish: Option<String>,
    from: Value,
    to: Value,
    /// Keys one action records beside the common nine (`add`'s `quantity`, `swap`'s `folded`,
    /// `remove`'s printing).
    extra: serde_json::Map<String, Value>,
}

impl Change {
    fn new(action: &'static str, from: Value, to: Value) -> Self {
        Self {
            action,
            card_id: None,
            finish: None,
            from,
            to,
            extra: serde_json::Map::new(),
        }
    }

    /// The entry the history row is about.
    fn about(mut self, card_id: &str, finish: &str) -> Self {
        self.card_id = Some(card_id.to_owned());
        self.finish = Some(finish.to_owned());
        self
    }

    fn with(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.to_owned(), value);
        self
    }
}

/// **The one place a token write records**, inside the transaction the caller already opened —
/// so the four writes cannot differ in how they journal.
///
/// In order: the deck fence (a read, answering `deck::GONE` for a stale editor's dead id before
/// anything else can refuse); a read of every entry of the token in `list` and of its state; the
/// write itself (`f`); the same read again; then — only if something changed —
/// [`crate::deck::touch_deck`], which moves the deck to the top of a gallery sorted by *recently
/// touched*, and **one** `deck_audit` row and **one** `deck_undo` step, keyed on it.
///
/// **The fence is a read and the touch comes last**, which is `touch_deck` split in two: its
/// `UPDATE` is the usual fence, but it stamps as it checks, so a swap onto the entry's own art
/// would move the deck to the top of the gallery for a press that changed nothing. Checking first
/// with a `SELECT` keeps `GONE` ahead of every other sentence a dead deck could otherwise hear
/// (`TOKEN_GONE`, `ENTRY_GONE`), and stamping after the no-op check keeps a no-op silent.
///
/// * **The history row is kind `deck` with `field: "token"`**, never a new kind — see this
///   module's header — and `delta` 0: a token is not a card, and the day header's `+7 / −6` adds
///   up cards. Its payload is `{ field, action, name, subtitle, card_id, finish, list, from, to }`
///   plus [`Change::extra`]; `name` and `subtitle` are the token's own, written down now because
///   a history is read after the corpus has moved. (`list` was `null` on a state write, which
///   was shared by both lists; every write since v55 is in one list.)
/// * **The step is [`Op::Tokens`] over the whole token in that list**, both sides: the undo side
///   deletes what the write left and restores what it found, the redo side the other way round.
///   `states` rides only when the state moved — a quantity step that recorded the state it did
///   not change would be refused by a later state write it never touched.
/// * **A write that changed nothing records nothing** — a stepper landing on the quantity it was
///   already at, a swap onto the entry's own art. `deck_set_card_quantity` removing a card
///   that is not there is the precedent: a history of a change that never happened is a line the
///   drawer would have to explain.
fn journal_in(
    tx: &Connection,
    deck_id: i64,
    list: &str,
    oracle_id: &str,
    f: impl FnOnce(&Connection) -> Result<Change, String>,
) -> Result<(), String> {
    let there: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM decks WHERE id = ?1)",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !there {
        return Err(crate::deck::GONE.to_owned());
    }
    let read = |tx: &Connection| -> Result<(Vec<TokenEntryRow>, TokenStateRow), String> {
        Ok((
            entries_of(tx, deck_id, list, oracle_id)?,
            state_of(tx, deck_id, oracle_id)?,
        ))
    };
    let (entries_before, state_before) = read(tx)?;
    let change = f(tx)?;
    let (entries_after, state_after) = read(tx)?;
    if entries_before == entries_after && state_before == state_after {
        return Ok(());
    }
    crate::deck::touch_deck(tx, deck_id)?;

    let token = newest_printing(tx, oracle_id)?;
    let mut payload = json!({
        "field": "token",
        "action": change.action,
        "name": token.as_ref().map(|p| p.name.clone()),
        "subtitle": token.as_ref().and_then(subtitle_of),
        "card_id": change.card_id,
        "finish": change.finish,
        "list": list,
        "from": change.from,
        "to": change.to,
    });
    if let Some(map) = payload.as_object_mut() {
        map.extend(change.extra);
    }
    let audit_id = crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &payload,
        0,
    )?;

    let moved = state_before != state_after;
    let undo = Op::Tokens {
        restore: entries_before.clone(),
        delete: entries_after.clone(),
        states: if moved { vec![state_before] } else { vec![] },
    };
    let redo = Op::Tokens {
        restore: entries_after,
        delete: entries_before,
        states: if moved { vec![state_after] } else { vec![] },
    };
    crate::deck_undo::record_step(tx, audit_id, deck_id, &Step::new(vec![undo], vec![redo]))
}

/// [`journal_in`] in a transaction of its own — what three of the four writes are. The fourth,
/// [`add_printing_in`], is also called from inside `deck::add_card`'s and
/// `collection_alloc::collection_to_deck`'s transactions, so it takes one rather than opening one.
fn write_tokens(
    conn: &Connection,
    deck_id: i64,
    list: &str,
    oracle_id: &str,
    f: impl FnOnce(&Connection) -> Result<Change, String>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    journal_in(&tx, deck_id, list, oracle_id, f)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Scryfall's colour letters as words, in WUBRG order — `deckTokens.ts`' `COLOR_WORDS`.
const COLOR_WORDS: [(char, &str); 5] = [
    ('W', "White"),
    ('U', "Blue"),
    ('B', "Black"),
    ('R', "Red"),
    ('G', "Green"),
];

/// The one-line disambiguator a history row names a token by — **`deckTokens.ts`'
/// `tokenSubtitle`, ported term for term**, because the drawer has to tell two `Wurm`s apart
/// long after the printing it was read off has left the corpus, so it is written down at the
/// write rather than recomputed at the read.
///
/// `<colours> <power>/<toughness> · <oracle text>`, any term with nothing to say left out, the
/// text's line breaks folded to ` · `, and `None` for an emblem (its type line already names the
/// planeswalker) or when no term has anything to say. Two tests pin the port against the
/// TypeScript's own examples: `every_token_write_is_one_deck_row_and_one_step` (the Treasure's
/// line) and `a_token_history_row_names_it_as_the_wall_does` (a Wurm's, and an emblem's none).
fn subtitle_of(p: &Printing) -> Option<String> {
    if p.layout == "emblem" {
        return None;
    }
    let present = |v: &Option<String>| v.clone().filter(|s| !s.trim().is_empty());
    let size = match (present(&p.power), present(&p.toughness)) {
        (Some(power), Some(toughness)) => Some(format!("{power}/{toughness}")),
        _ => None,
    };
    let colours = p.colors.as_deref().map(|letters| {
        let words: Vec<&str> = COLOR_WORDS
            .iter()
            .filter(|(letter, _)| letters.contains(*letter))
            .map(|(_, word)| *word)
            .collect();
        if words.is_empty() {
            "Colorless".to_owned()
        } else {
            words.join(" ")
        }
    });
    let head = [colours, size]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let text = one_line(p.oracle_text.as_deref().unwrap_or(""));
    let parts: Vec<String> = [head, text].into_iter().filter(|s| !s.is_empty()).collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// Oracle text on one line: every run of whitespace holding a line break becomes ` · `, and the
/// ends are trimmed — `tokenSubtitle`'s `/\s*\n+\s*/g`, which is a maximal whitespace run with at
/// least one newline in it.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    for c in text.chars() {
        if c.is_whitespace() {
            run.push(c);
            continue;
        }
        if !run.is_empty() {
            out.push_str(if run.contains('\n') { " · " } else { &run });
            run.clear();
        }
        out.push(c);
    }
    if run.contains('\n') {
        out.push_str(" · ");
    }
    out.trim().to_owned()
}

/// A swap's `from` and `to`: the entry, and the set and number it was read as.
fn entry_facts(conn: &Connection, row: &TokenEntryRow) -> Result<Value, String> {
    let chin: Option<(String, String)> = conn
        .query_row(
            "SELECT set_code, collector_number FROM cards WHERE id = ?1",
            params![row.card_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "card_id": row.card_id,
        "finish": row.finish,
        "set_code": chin.as_ref().map(|c| c.0.clone()),
        "collector_number": chin.map(|c| c.1),
    }))
}

/// **Rules 2 and 3**: set one entry of a token — or its implicit entry — to an absolute quantity.
///
/// `entry: None` is the implicit entry, which this **materialises** at the list's default
/// printing before stepping it (rule 2) — in this list only (rule 6), so the other list goes on
/// drawing its own. **Zero deletes the entry, unless it is the token's last entry in this list**,
/// which stays at zero (rule 3): the implicit default must not reappear under a reader who zeroed
/// the only printing they had, which is today's "kept at zero, art kept".
///
/// A negative number is refused through the collection's one sentence for it.
pub fn set_quantity(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
    entry: Option<&TokenEntryKey>,
    quantity: i64,
) -> Result<(), String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let quantity = crate::collection::valid_quantity(quantity, "token quantity")?;
    write_tokens(conn, deck_id, variant, oracle_id, |tx| {
        let (target, implicit) = named_entry(tx, deck_id, variant, oracle_id, entry)?;
        if implicit {
            put_entry(tx, deck_id, &target)?;
        }
        let others = entries_of(tx, deck_id, variant, oracle_id)?.len() - 1;
        if quantity == 0 && others > 0 {
            drop_entry(tx, deck_id, &target)?;
        } else {
            put_entry(
                tx,
                deck_id,
                &TokenEntryRow {
                    quantity,
                    ..target.clone()
                },
            )?;
        }
        settle_hidden(tx, deck_id, variant, oracle_id)?;
        Ok(
            Change::new("quantity", json!(target.quantity), json!(quantity))
                .about(&target.card_id, &target.finish),
        )
    })
}

/// **Rule 4**: move one entry — or the implicit entry — onto another printing and/or finish of
/// the same token, and **fold** when the list already holds that one (quantities summed, one
/// row, on the grain).
///
/// `to` must be a printing **of this token** ([`NOT_THIS_TOKEN`]) in a finish it is sold in, and
/// is checked before anything is written. Swapping an entry onto itself is a success that writes
/// nothing — which includes the implicit entry onto its own printing, so opening the picker and
/// closing it on the tile's own art materialises nothing. **The picker's own swap never touches
/// the token's other entries**: they are neither the source nor the destination.
pub fn swap(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
    from: Option<&TokenEntryKey>,
    to: &TokenEntryKey,
) -> Result<(), String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let printing = printing_by_id(conn, &to.card_id)?;
    if printing.oracle_id != oracle_id {
        return Err(NOT_THIS_TOKEN.to_owned());
    }
    let finish = entry_finish(&printing, Some(&to.finish))?;
    write_tokens(conn, deck_id, variant, oracle_id, |tx| {
        let (source, _) = named_entry(tx, deck_id, variant, oracle_id, from)?;
        if source.card_id == printing.id && source.finish == finish {
            return Ok(Change::new("swap", Value::Null, Value::Null));
        }
        // The implicit entry is never in the table, so deleting its grain is a no-op and the
        // swap *is* its materialisation — at the destination, which is what "adding art B keeps
        // art A" asks of an add and not of a swap.
        drop_entry(tx, deck_id, &source)?;
        let held = entries_of(tx, deck_id, variant, oracle_id)?
            .into_iter()
            .find(|e| e.card_id == printing.id && e.finish == finish);
        let landed = TokenEntryRow {
            card_id: printing.id.clone(),
            finish: finish.clone(),
            quantity: held.as_ref().map_or(0, |e| e.quantity) + source.quantity,
            ..source.clone()
        };
        put_entry(tx, deck_id, &landed)?;
        settle_hidden(tx, deck_id, variant, oracle_id)?;
        Ok(
            Change::new("swap", entry_facts(tx, &source)?, entry_facts(tx, &landed)?)
                .about(&landed.card_id, &landed.finish)
                .with("folded", json!(held.is_some())),
        )
    })
}

/// [`add_printing_in`] in a transaction of its own, at one copy — the band's **Add printing**.
pub fn add_printing(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    card_id: &str,
    finish: Option<&str>,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let landed = add_printing_in(&tx, deck_id, variant, card_id, finish, 1)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(landed)
}

/// **Rule 5, the whole write, inside the caller's transaction**: file `quantity` copies of one
/// printing in one finish as an entry of its token in `variant`, and answer the quantity the
/// entry landed on.
///
/// In order: the token is read off the printing ([`NO_SUCH_PRINTING`]), which has to be a token
/// or an emblem ([`NOT_A_TOKEN`], [`is_token_printing`]); the finish is the one
/// asked for, fenced, or the printing's default ([`entry_finish`]); then, under [`journal_in`] —
/// the deck is touched, and the history row and the undo step are written:
///
/// 1. **An implicit entry is materialised first** (rule 2), so adding art B to a token drawn at
///    art A keeps A — the whole point of the rule. Only a derived token has one, and **only one
///    at a count is materialised**: since v55 an untouched implicit entry is at zero, which step 2
///    would clear again in the same write, so writing it would be a captured insert and delete of
///    a row nobody saw, sent to every device in the group. B is filed alone; what keeps A is a
///    legacy count.
/// 2. The entry is inserted at `quantity`, or an existing entry of that printing and finish is
///    stepped up by it — and **the token's zero-quantity entries in this list are deleted**,
///    never the one just added to. Rule 3 held one at zero because it was the last; beside the
///    new entry it is not, and a `0` tile no stepper can zero again is stuck on the band. The
///    deletes are the write's own, so one Undo restores them.
/// 3. **A token the list derives nothing for becomes `manual`** — the reader's own, which no cut
///    can reconcile away. A derived token still `hidden` from a pre-v55 dismissal comes back to
///    `auto`, as [`retire_hidden`] would have sent it at the next launch — and **at zero**: its
///    legacy count is cleared before step 1 ([`clear_legacy_count`]), so no implicit entry is
///    materialised at the dismissal's old count.
///
/// **The three callers** are this module's [`add_printing`] (one copy, from the band's picker),
/// and the two writes every add of a card ends in — `deck::add_card` and
/// `collection_alloc::collection_to_deck` — which send here every printing
/// [`printing_is_token`] answers `true` for, rather than writing a `deck_cards` row: a token is
/// never a deck card. That is why this takes a transaction rather than opening one.
pub fn add_printing_in(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    card_id: &str,
    finish: Option<&str>,
    quantity: i64,
) -> Result<i64, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    if quantity <= 0 {
        return Err(crate::collection::ZERO_ADD.to_owned());
    }
    let printing = printing_by_id(tx, card_id)?;
    if !is_token_printing(&printing.layout, printing.type_line.as_deref()) {
        return Err(NOT_A_TOKEN.to_owned());
    }
    let finish = entry_finish(&printing, finish)?;
    let oracle_id = printing.oracle_id.clone();
    let mut landed = 0;
    journal_in(tx, deck_id, variant, &oracle_id, |tx| {
        let best = derived_printing(tx, deck_id, variant, &oracle_id)?;
        let derived = best.is_some();
        // **A stale `hidden` comes back at zero, and before the implicit entry is written** (the
        // final review's deferred 1): its legacy count is what the implicit entry would be
        // materialised at, and a dismissal the reader is settling by using the token comes back
        // at none — so the entry this press files stands alone, as `retire_hidden` would have left
        // it, rather than beside the old count in this list and under it in the other.
        let was_hidden = state_of(tx, deck_id, &oracle_id)?.state.as_deref() == Some(HIDDEN_STATE);
        if was_hidden {
            clear_legacy_count(tx, deck_id, &oracle_id)?;
        }
        if entries_of(tx, deck_id, variant, &oracle_id)?.is_empty() {
            if let Some(implicit) = implicit_of(tx, deck_id, variant, &oracle_id, best)?
                .filter(|implicit| implicit.quantity > 0)
            {
                put_entry(tx, deck_id, &implicit)?;
            }
        }
        let held = entries_of(tx, deck_id, variant, &oracle_id)?
            .into_iter()
            .find(|e| e.card_id == printing.id && e.finish == finish)
            .map_or(0, |e| e.quantity);
        landed = held + quantity;
        put_entry(
            tx,
            deck_id,
            &TokenEntryRow {
                variant: variant.to_owned(),
                oracle_id: oracle_id.clone(),
                card_id: printing.id.clone(),
                finish: finish.clone(),
                quantity: landed,
            },
        )?;
        // Rule 3's zero is *the last entry, held at none*; the entry just filed means it is not
        // the last any more, and a `0` tile left beside it is one no stepper can send to zero
        // again. So the token's other zero entries in this list go — inside this write, so the
        // step's before-and-after carries them and one Undo restores them.
        for zero in entries_of(tx, deck_id, variant, &oracle_id)?
            .into_iter()
            .filter(|e| e.quantity == 0 && !(e.card_id == printing.id && e.finish == finish))
        {
            drop_entry(tx, deck_id, &zero)?;
        }
        if !derived {
            write_state(tx, deck_id, &oracle_id, MANUAL_STATE)?;
        } else if was_hidden {
            write_state(tx, deck_id, &oracle_id, AUTO_STATE)?;
        }
        Ok(Change::new("add", json!(held), json!(landed))
            .about(&printing.id, &finish)
            .with("quantity", json!(quantity)))
    })?;
    Ok(landed)
}

/// **Remove printing** (the token-improvements spec §3.4): delete one entry of a token in one
/// list, **unconditionally** — the one write that can take a token's last entry, which a stepper
/// holds at zero (rule 3) — and answer [`ENTRY_GONE`] for an entry that is not there.
///
/// What the list draws afterwards follows from rule 1 with nothing more written, except in one
/// case:
///
/// * **A derived token** whose last entry here goes falls back to its implicit entry — the
///   default printing, at [`implicit_quantity`] — which is what the retired Reset printings did,
///   one printing at a time. Its state is not touched.
/// * **A hand-added token** — one this list derives nothing for — is drawn only where it holds an
///   entry, so it leaves this list's band. **When it holds none in either list**, its state goes
///   back to `auto` through [`write_state`], which deletes the row: a `manual` row with no entry
///   anywhere would be a token on no wall that no cut could ever reconcile away. An add of it
///   later makes it `manual` again.
///
/// Journalled by [`journal_in`] like every token write: one `deck` row with `action: "remove"`
/// and one [`Op::Tokens`] step, which carries the state as well when it moved, so one Undo puts
/// back the entry and the reader's `manual` together. Beside the common keys the payload carries
/// `oracle_id`, `set_code` and `collector_number` — the printing as the drawer names it
/// (*Removed Treasure's TMOM #12 printing*), read now because a history is read after the corpus
/// has moved — with `from` the copies the entry held and `to` null.
pub fn remove_entry(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    oracle_id: &str,
    entry: &TokenEntryKey,
) -> Result<(), String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    write_tokens(conn, deck_id, variant, oracle_id, |tx| {
        let (target, _) = named_entry(tx, deck_id, variant, oracle_id, Some(entry))?;
        drop_entry(tx, deck_id, &target)?;
        settle_hidden(tx, deck_id, variant, oracle_id)?;
        let held_anywhere: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deck_token_printings
                                WHERE deck_id = ?1 AND oracle_id = ?2)",
                params![deck_id, oracle_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !held_anywhere && derived_printing(tx, deck_id, variant, oracle_id)?.is_none() {
            write_state(tx, deck_id, oracle_id, AUTO_STATE)?;
        }
        let facts = entry_facts(tx, &target)?;
        Ok(Change::new("remove", json!(target.quantity), Value::Null)
            .about(&target.card_id, &target.finish)
            .with("oracle_id", json!(oracle_id))
            .with("set_code", facts["set_code"].clone())
            .with("collector_number", facts["collector_number"].clone()))
    })
}

// ---------------------------------------------------------------------------------------
// Rule 7 — a token nothing makes any more is removed at zero and kept with copies
// ---------------------------------------------------------------------------------------

/// What one [`reconcile_in`] did, for the caller's undo step: the entries it deleted, and the
/// tokens it kept as the reader's own — each one's `deck_tokens` state before and after, in the
/// same order.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// The entries at zero it deleted — restored on the undo side, deleted again on the redo side.
    pub removed: Vec<TokenEntryRow>,
    /// The kept tokens' states as they stood before the reconcile made them `manual`.
    pub states_before: Vec<TokenStateRow>,
    /// The same tokens' states after — `manual`, with whatever legacy columns the row carried.
    pub states_after: Vec<TokenStateRow>,
}

impl Reconciled {
    /// Whether the reconcile changed nothing — no entry deleted, no token kept.
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty() && self.states_before.is_empty()
    }
}

/// **Rule 7**: settle every entry, in each of `variants`, of a token that list no longer derives
/// and whose state is `auto` — and answer what it changed, so the caller's undo step can put it
/// back.
///
/// **An entry at zero is deleted; a token with copies is kept and becomes `manual`**
/// ([issue #671](https://github.com/Msgaihede/mtg-grimoire/issues/671)). Until then every entry
/// went, which lost the one fact a reader needs after cutting a card: that the physical deck still
/// has three Treasures in it that should come out. Kept, the token is drawn by
/// [`deck_token_rows`]' hand-added tail with `derived: false` — the red outline and the
/// `NOT MADE BY DECK` badge a token added by hand wears — until the reader removes it or steps it
/// down. **`manual` rather than a new rule for `auto`**, because the state is what every build
/// reads: a peer still on an older build leaves a `manual` token alone, where an `auto` one with
/// entries and no maker is exactly what its own reconcile deletes and pushes to the group. The
/// flip is written only when the reconcile keeps something, after every list has been walked, so a
/// token kept in one list still has its zero entries in another list that does not make it
/// deleted by the same pass.
///
/// **A reconcile after every write that changes a list's cards, never a rule applied at read
/// time** — reading around a stale entry would leave it in the table (and, in PR 3's Collection
/// mode, its copies in the deck's folder), which is the stranding this rule exists to prevent.
/// Two layers call it (spec §4.2):
///
/// * **Inside the write's own transaction**, for every write that files an undo step, so the
///   deletions ride the step: `deck_undo::record_cells` and `record_variant`, and by hand the
///   three steps built without them — the theory switch, a pile switched off, a pile deleted.
/// * **After every write, as a backstop** ([`reconcile_dirty`]), for the writes that file none.
///
/// **Only an `auto` token is the deck's to take** — the one [`deck_token_rows`]' hand-added tail
/// does not draw once nothing makes it. **A `manual` token is never touched** — no card made it, so
/// no cut can unmake it — **and nor, since the final review of user schema v55, is a `hidden`
/// one**: that tail draws any state but `auto`, so a pre-v55 dismissal of a token nothing makes is
/// on the wall like a `manual` one, and until [`retire_hidden`] settles it at the next launch it is
/// as much the reader's. It said the opposite until then — *a dismissal is still a token the deck
/// makes, and once it does not, it has nothing left to be dismissed from* — which was true while a
/// dismissal was hidden, and took the entries of a token the wall was drawing, captured, and from
/// the backstop on no undo step. Cutting a card and adding it back brings an `auto` token the
/// reader never used back as its implicit entry, which is what they had anyway; one they had
/// copies of was kept as `manual`, and the card coming back makes it `derived` again — the outline
/// goes, the copies stay, and the state stays `manual` (Ctrl+Z on the cut is what puts `auto`
/// back, through the step's states).
///
/// **Three things keep it cheap and one keeps it safe.** The common case — a list with no
/// entries of an `auto` token at all — is one indexed read and no derivation. A list is only derived
/// when there is something it could settle. The deletes are ordinary captured writes: every
/// device derives the same answer, a delete that finds nothing is a no-op there, and a captured
/// delete keeps an undo's captured restore meaningful on the other device. **And a list whose
/// makers cannot all be read deletes nothing** ([`Derivation::unreadable`]) — it cannot prove a
/// token unneeded, and a device whose corpus is not there yet would otherwise wipe every token
/// printing the reader has and push the wipe to the group.
pub fn reconcile_in(
    tx: &Connection,
    deck_id: i64,
    variants: &[&str],
) -> Result<Reconciled, String> {
    let mut out = Reconciled::default();
    // A `BTreeSet` so the states ride the step in one order on every device.
    let mut kept: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for variant in variants {
        let variant = crate::deck_meta::valid_variant(variant)?;
        let candidates: Vec<TokenEntryRow> = {
            let mut stmt = tx
                .prepare(
                    "SELECT e.variant, e.oracle_id, e.card_id, e.finish, e.quantity
                       FROM deck_token_printings e
                      WHERE e.deck_id = ?1 AND e.variant = ?2
                        AND NOT EXISTS (SELECT 1 FROM deck_tokens t
                                         WHERE t.deck_id = e.deck_id
                                           AND t.oracle_id = e.oracle_id
                                           AND t.state <> ?3)
                      ORDER BY e.oracle_id, e.card_id, e.finish",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![deck_id, variant, AUTO_STATE], entry_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(|e| e.to_string())?
        };
        if candidates.is_empty() {
            continue;
        }
        let derivation = derive(tx, deck_id, variant)?;
        if derivation.unreadable {
            continue;
        }
        for row in candidates {
            if derivation.tokens.contains_key(&row.oracle_id) {
                continue;
            }
            if row.quantity > 0 {
                kept.insert(row.oracle_id.clone());
                continue;
            }
            drop_entry(tx, deck_id, &row)?;
            out.removed.push(row);
        }
    }
    for oracle_id in kept {
        out.states_before.push(state_of(tx, deck_id, &oracle_id)?);
        write_state(tx, deck_id, &oracle_id, MANUAL_STATE)?;
        out.states_after.push(state_of(tx, deck_id, &oracle_id)?);
    }
    Ok(out)
}

/// **The backstop**: [`reconcile_in`] over both lists of every deck a write since the last settle
/// touched, run by [`crate::sync::with_write`] after every write — for the writes that file no
/// undo step: `collection_alloc`'s filing and cut, a sync pull, and **undo and redo themselves**.
/// Its deletions sit in no step, so a redo does not bring back entries a post-undo reconcile
/// removed — the one cost of the arrangement.
///
/// **Scryfall's `reconcile::apply` is covered one write late.** It takes the write connection
/// through `sync::lock_db` rather than `with_write`, so no backstop runs after it; the marks its
/// `deck_cards` writes leave in the dirty table are reconciled at the **next** write through
/// `with_write`, on any deck. A token its repoint stopped deriving keeps its entries until then.
///
/// **"Touched" is the managed wishlist's TEMP dirty-deck table**, which that module's `arm`
/// fills from triggers on `deck_cards`, `deck_categories` and `decks` — read here and **never
/// cleared**: `managed_wishlist::settle` is what empties it, which is why `with_write` runs this
/// *before* the settle rather than after it, where the table would already be empty. A
/// connection that was never armed has no table and nothing to reconcile. **The triggers user
/// schema v55 added on `deck_token_printings` and `deck_tokens` mark a table of their own**,
/// `managed_wishlist_token_dirty`, which the settle alone reads: a token write changes no card, so
/// it gives this reconcile nothing to do, and marked here every stepper press would derive both
/// of its deck's lists for nothing.
///
/// One transaction per deck, so a deck that fails leaves every other deck reconciled; the first
/// failure is the answer.
pub fn reconcile_dirty(conn: &Connection) -> Result<(), String> {
    let armed: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM temp.sqlite_master
                            WHERE type = 'table' AND name = 'managed_wishlist_dirty')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !armed {
        return Ok(());
    }
    let dirty: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT deck_id FROM temp.managed_wishlist_dirty ORDER BY deck_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?
    };
    let mut first_err = None;
    for deck_id in dirty {
        let done = conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())
            .and_then(|tx| {
                reconcile_in(&tx, deck_id, &crate::schema::DECK_VARIANTS)?;
                tx.commit().map_err(|e| e.to_string())
            });
        if let Err(e) = done {
            first_err.get_or_insert(e);
        }
    }
    first_err.map_or(Ok(()), Err)
}

/// [`reconcile_dirty`] with its failure written to stderr rather than returned — what
/// [`crate::sync::with_write`] calls, because the reader's own write has already committed and a
/// token the backstop could not reconcile is not a reason to report that write failed. The next
/// write that touches the deck tries again.
pub fn reconcile_dirty_logged(conn: &Connection) {
    if let Err(e) = reconcile_dirty(conn) {
        eprintln!("a deck's tokens could not be reconciled with its cards: {e}");
    }
}

/// One v51 art pick still on `deck_tokens`: `(deck, oracle, card, quantity, uid)`.
type LegacyPick = (i64, String, String, Option<i64>, Option<String>);

/// The `sync_state` key a paired device's legacy picks wait on — set by the first pull this
/// device applies at user schema v52, and never cleared.
///
/// What it records is that this device has **heard its group** since it climbed: every entry a
/// peer already derived from the same picks, and every clear behind them. That is the one thing
/// [`convert_legacy_picks_at_launch`] has to know before a paired device may convert, and
/// [`convert_legacy_picks_after_pull`] is its only writer. A device in no group never reads it.
pub const PICKS_READY: &str = "token_picks_ready";

/// **The launch half of the conversion's gate** — what `schema::prepare_database` runs, after
/// `capture::install` and before [`repair_entry_finishes`], logged and left owing like its
/// neighbours.
///
/// **A device in no sync group converts here, at every launch**, as it always did: its writes
/// record no op, and a pairing later hands its peers the finished entries in a baseline. **A
/// device in a group converts here only once [`PICKS_READY`] is set**, and until then leaves its
/// picks to [`convert_legacy_picks_after_pull`], which runs behind its first pull at v52.
///
/// **Why a paired device waits** (2026-09-26, the token-stacks PR 2 review's fifth round): a
/// conversion at launch is a conversion **before the device has heard its group**, and a
/// laggard's conversion then silently reverts what an earlier climber did since. Device A climbs,
/// converts a pick at count 3 and steps the live entry to 5. Device B, still on v51, pulls A's
/// batch and defers it — `deck_token_printings` is a table it does not know, and A's clear of the
/// pick rides behind the entries, so B still holds the pick — but B's clock observes every stamp
/// in the batch, deferred ones included (`sync_engine::apply`'s `observe`). Converting at launch,
/// B inserted `<uid>-live` at the legacy 3 under a stamp later than anything A wrote, and that
/// insert won every field last-writer-wins decides: A's step, a finish change or a theory-switch
/// move reverted on **both** devices, and an entry A had deleted came back. Behind a pull, B has
/// applied A's entries and A's clear first: the clear leaves no pick to convert, and a pick B
/// re-made after it is converted as case 3's move of the entry A named — a sparse update — never
/// as an insert over it. `a_laggards_conversion_never_reverts_an_edit_made_since` is that
/// scenario, and it went red (3 on both devices, not 5) with this gate switched off.
///
/// ⚠️ **"Behind a pull, B has applied A's entries" rests on a re-delivery a v51 client does not
/// do.** B deferred A's batch at v51, and B's v51 client advanced its cursor past it all the same,
/// so B's first pull at v52 does not bring it back: a B that *pulled* at v51 during the window
/// still holds the pick after it climbs, and converting behind that pull is the same late insert.
/// The gate closes the reversion for a laggard that did not pull during the window, and for every
/// laggard on v52 or later, whose client holds its cursor on a newer-schema deferral and converts
/// behind an advancing pull only (`sync.md`, *Held while it can resolve, skipped when it
/// cannot*).
///
/// **What it costs**: a paired device draws each unconverted token as its implicit entry — the
/// resolver's printing, not the art the reader picked on v51 — until its first pull at v52 lands,
/// which on a device the connection manager can reach is seconds after launch. A paired device
/// that completes no pull (a group with no membership, a relay it cannot reach, a pull held
/// behind a key rotation) goes on drawing the default until one does.
pub fn convert_legacy_picks_at_launch(conn: &Connection) -> Result<(), String> {
    let waits: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM sync_group)
                    AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key = ?1)",
            [PICKS_READY],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if waits {
        return Ok(());
    }
    convert_legacy_picks(conn)
}

/// **The pull half of the conversion's gate** — what `sync_engine::client::pull` runs straight
/// after a pull's `apply` has committed and the cursor has moved. It sets [`PICKS_READY`], so
/// every launch after it converts too, and then converts **captured**: `apply` has returned, and
/// `capture::suppressed` with it.
///
/// **Behind every such pull, not only the first**, which closes what the launch pass alone left
/// to the next launch: a v51 peer's pick arriving in a pull is converted and announced on the
/// pull that brings it. It stays idempotent and cheap — [`convert_legacy_picks`] returns on its
/// first read when no pick is set, and the key is an `INSERT OR IGNORE` — so a pull with nothing
/// to convert writes nothing.
pub fn convert_legacy_picks_after_pull(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_state (key, value) VALUES (?1, '1')",
        [PICKS_READY],
    )
    .map_err(|e| e.to_string())?;
    convert_legacy_picks(conn)
}

/// **The v51 art picks become entries, captured** (user schema v52, the token-stacks spec §4.3).
/// Nothing in production calls this directly: [`convert_legacy_picks_at_launch`] and
/// [`convert_legacy_picks_after_pull`] are its gate, and their docs say who runs which and why a
/// paired device waits for a pull.
///
/// A pick is a `deck_tokens` row whose legacy `card_id` is set — v51's one art, shared by both
/// lists. Each becomes **one entry per list**, named `<pick uid>-<list>`, at
/// `max(coalesce(quantity, 1), 0)`, and the pick is then cleared. The floor is there because
/// `deck_tokens.quantity` has no `CHECK` — it is a synced field, so a peer or an old build can
/// have put any integer there — and the entry table refuses a count below zero; zero is the
/// entry's own "stepped to nothing".
///
/// **A pick with no uid is named first**, `UPDATE deck_tokens SET sync_uid = <the mint>` — only a
/// write behind `capture::suppressed` leaves one, and `sync_uid` is on no capture spec, so the
/// naming is not an op. Its entries then derive from that name like any other's. Until the fifth
/// review round such a pick's entries took a random uid each and its clear was captured, and on a
/// paired device the clear's update trigger put the pick's NULL into `sync_ops.uid NOT NULL` and
/// failed the whole pass. **Its clear is written behind `capture::suppressed`**, and that part is
/// deliberate: a nameless pick was never announced under any name, so a captured clear would be a
/// sparse `{card_id, quantity}` update for a uid no peer holds, carrying no grain term to be
/// matched by — a row no peer can build, skipped and recorded in every peer's `error_log` since
/// 2026-09-27 (deferred before that, with this device's later ops in the page lost behind it). The
/// entries themselves are announced whole, as every conversion's are.
/// `a_nameless_pick_on_a_paired_device_is_named_and_stalls_no_peer` holds both halves.
///
/// **The finish is the printing's own [`default_finish`]**, read from the corpus — the function
/// an implicit entry is drawn in and an add naming no finish files, so a converted Treasure lands
/// in the finish the reader was already looking at. v51 stored a printing and no finish, and the
/// retired rung wrote `nonfoil` for every art and left [`repair_entry_finishes`] to correct it,
/// only because no rung reads the corpus. This runs after `migrate_corpus` and can. It matters
/// for more than the first draw: every device whose corpus holds the printing announces
/// **identical content** under one name, so no conversion can hand a peer a `nonfoil` put that
/// lands after that peer's repair and writes the guess back, or that misses a repaired entry on
/// the grain and lands beside it as a second row. **A corpus that cannot say** — the printing is
/// absent, its `finishes` will not parse, or there is no `cards` table to ask — answers
/// `default_finish(None)`, which is `nonfoil`, and the repair stays as the net for exactly that
/// entry once a sync brings the printing.
///
/// **Why not in the rung, and why captured.** The v52 rung did this until 2026-09-26, uncaptured,
/// on the argument that every device climbs over the same synced picks and so derives the same
/// rows under the same names. A group with a device still on v51 breaks that. A pick made there
/// after this device climbed was converted by the picker alone, under a name this device had
/// never heard, and the picker's next count step reached this device as a sparse `{quantity}`
/// update for a row it could not find — deferred, and the picker's whole stream held behind it
/// for good; a two-device test reproduced exactly that before this moved. The reverse held too:
/// a pick the v51 device reset left this device the only holder of an entry, and its own later
/// steps stalled its stream the other way. **An entry that announces itself with a captured
/// insert cannot be unknown to a peer**: one that derived it too merges on the uid, and one that
/// did not builds the row from the put. And because this runs behind every pull and at every
/// launch the gate allows, a pick that arrives afterwards — a v51 device picking after this one
/// converted — is converted on the pull that brings it.
///
/// Per pick, per list, in `(deck_id, oracle_id)` order:
///
/// 1. **The list already holds the token at the picked printing, in any finish** — leave it.
///    The finish repair may have moved an earlier conversion to `foil`, or a reader on v52 may
///    have added the printing; a second row would be a second entry for one art.
/// 2. **Another token's entry holds the grain** — skip. `deck_tokens`' grain is
///    `(deck_id, oracle_id)`, so two tokens of one deck can have picked one printing (a
///    double-faced token carries two tokens on one card), and the pick first in `oracle_id`
///    order already took it. Every device sorts one synced row set alike, so each keeps the same
///    winner and names it alike; rowid order would give two devices two names for one entry.
///    The loser keeps its count as its token's implicit one and loses only the art.
/// 3. **The entry this pick named at an earlier conversion is still there** — here, or on a peer
///    that announced it — move it: a v51 device re-picked after the conversion. Its printing is
///    rewritten in place, and its finish to the new printing's default, keeping the row, the
///    count and the name every peer holds it by, so the captured update lands on theirs. The
///    count stays, because a re-pick carries no count and the entry's is the reader's own.
/// 4. **Otherwise insert it.**
///
/// Then every pick's `card_id` is cleared, and its `quantity` wherever an entry of its token now
/// exists — **all the entries first and the clears after**, so every clear rides behind an entry
/// op in this device's stream. A v51 peer defers the first op for a table it does not know and
/// leaves this device's later ops in that page unapplied, so it never applies a clear ahead of
/// its entry and goes on drawing its art. ⚠️ **Not "until it upgrades"**, which this read: a v51
/// client advances its pull cursor past a deferral, so the peer drops the entries and the clears
/// alike and draws its art after it upgrades too — the delivery holds that make a v52 client hold
/// a newer sender's page instead cannot reach back for one a v51 build stepped past (`sync.md`,
/// *Held while it can resolve, skipped when it cannot*). (In a group of three or more that can
/// fail cosmetically: a conversion that finds every list already holding the pick — a third
/// device's announced entries — writes no entry op, and if no other pick's entry precedes it the
/// clear reaches the v51 peer first, which then draws its default art.)
///
/// **One savepoint per pick, never one transaction for the file.** A pick whose entries or clear
/// fail is rolled back to its own savepoint, written to stderr beside the deck and token it
/// belongs to, and left set, so it is tried again behind the next pull or at the next launch the
/// gate allows; every other pick still converts. Before the fifth review round one failure — a
/// case-3 move colliding on the grain in the other list, say — rolled back every conversion in
/// the file, at every launch, for good.
///
/// **Idempotent and cheap**: a cleared pick is never read again, so every run after the first
/// scans a table of one row per deviated token and writes nothing, no op included. **Two losses
/// are accepted, both confined to a v51 device's last days**: a reset made there after this
/// device converted is lost — argued as "this device's entry reaches it after the upgrade and the
/// reset has nothing left to clear", and, while a deferral is dropped, the entry never reaches it
/// at all; and a count stepped there on a pick this device has already cleared lands on the
/// legacy column, which a converted token no longer reads.
pub fn convert_legacy_picks(conn: &Connection) -> Result<(), String> {
    let picks: Vec<LegacyPick> = {
        let mut stmt = conn
            .prepare(
                "SELECT t.deck_id, t.oracle_id, t.card_id, t.quantity, t.sync_uid
                   FROM deck_tokens t JOIN decks d ON d.id = t.deck_id
                  WHERE t.card_id IS NOT NULL
                  ORDER BY t.deck_id, t.oracle_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?
    };
    if picks.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The picks whose entries are in, and whose captured clear is still owed.
    let mut owed: Vec<&LegacyPick> = Vec::with_capacity(picks.len());
    {
        // `None` when there is no `cards` table to ask — a corpus an ingest has not filled —
        // which answers the same `nonfoil` an absent printing does; see the doc.
        let mut finishes = tx.prepare("SELECT finishes FROM cards WHERE id = ?1").ok();
        for pick in &picks {
            let listed: Option<String> = finishes.as_mut().and_then(|stmt| {
                stmt.query_row([&pick.2], |r| r.get::<_, Option<String>>(0))
                    .optional()
                    .ok()
                    .flatten()
                    .flatten()
            });
            let finish = default_finish(listed.as_deref());
            let converted = one_row(&tx, || {
                let (uid, named_here) = name_of(&tx, pick)?;
                for variant in crate::schema::DECK_VARIANTS {
                    convert_pick_in(&tx, pick, &uid, variant, finish)?;
                }
                // A pick named just now was never announced, so its clear goes uncaptured and
                // now — see the doc — and nothing about it is owed to the second loop.
                if named_here {
                    crate::sync_engine::capture::suppressed(&tx, || clear_pick(&tx, pick))?;
                }
                Ok(named_here)
            });
            match converted {
                Ok(false) => owed.push(pick),
                Ok(true) => {}
                Err(e) => skipped(pick, &e),
            }
        }
    }
    for pick in owed {
        if let Err(e) = one_row(&tx, || clear_pick(&tx, pick)) {
            skipped(pick, &e);
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Run one row's writes inside a savepoint of their own: released when `f` succeeds, rolled back
/// to when it fails, so one row's failure costs that row alone — a pick in
/// [`convert_legacy_picks`], a dismissal in [`retire_hidden`]. Both are launch passes over every
/// deck at once, where one transaction for the file would let one bad row undo every other, at
/// every launch, for as long as it kept failing.
fn one_row<T>(tx: &Connection, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    tx.execute_batch("SAVEPOINT token_pass")
        .map_err(|e| e.to_string())?;
    match f() {
        Ok(value) => tx
            .execute_batch("RELEASE token_pass")
            .map(|()| value)
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = tx.execute_batch("ROLLBACK TO token_pass; RELEASE token_pass");
            Err(e)
        }
    }
}

/// What a pick that could not be converted writes, and where: stderr, as every neighbour of the
/// launch pass does, because nothing a reader could act on is gained by a sentence in the log.
fn skipped(pick: &LegacyPick, e: &str) {
    eprintln!(
        "a pre-v52 token art pick (deck {}, token {}) could not be converted: {e}\nIt is tried \
         again at the next pull or launch; the deck's other picks converted, and until then this \
         token draws its default printing.",
        pick.0, pick.1
    );
}

/// The pick's name, and whether it was minted here: a pick with no `sync_uid` is given the
/// capture trigger's own mint before anything derives from it — [`convert_legacy_picks`]' doc.
fn name_of(tx: &Connection, pick: &LegacyPick) -> Result<(String, bool), String> {
    if let Some(uid) = &pick.4 {
        return Ok((uid.clone(), false));
    }
    let uid: String = tx
        .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE deck_tokens SET sync_uid = ?1
          WHERE deck_id = ?2 AND oracle_id = ?3 AND sync_uid IS NULL",
        params![uid, pick.0, pick.1],
    )
    .map_err(|e| e.to_string())?;
    Ok((uid, true))
}

/// Clear one pick: its `card_id` always, its `quantity` wherever an entry of its token now exists.
fn clear_pick(tx: &Connection, pick: &LegacyPick) -> Result<(), String> {
    tx.execute(
        "UPDATE deck_tokens
            SET card_id = NULL,
                quantity = CASE WHEN EXISTS (SELECT 1 FROM deck_token_printings e
                                              WHERE e.deck_id = deck_tokens.deck_id
                                                AND e.oracle_id = deck_tokens.oracle_id)
                                THEN NULL ELSE quantity END,
                updated_at = unixepoch()
          WHERE deck_id = ?1 AND oracle_id = ?2",
        params![pick.0, pick.1],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// One pick into one list, in `finish`, named after `uid` — [`convert_legacy_picks`]' four
/// cases, in its order.
fn convert_pick_in(
    tx: &Connection,
    pick: &LegacyPick,
    uid: &str,
    variant: &str,
    finish: &str,
) -> Result<(), String> {
    let (deck_id, oracle_id, card_id, quantity, _) = pick;
    let exists = |sql: &str, values: &[&dyn rusqlite::ToSql]| -> Result<bool, String> {
        tx.query_row(sql, values, |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    // 1. The token is already at this printing here, in some finish.
    if exists(
        "SELECT EXISTS(SELECT 1 FROM deck_token_printings
                        WHERE deck_id = ?1 AND variant = ?2 AND oracle_id = ?3 AND card_id = ?4)",
        &[deck_id, &variant, oracle_id, card_id],
    )? {
        return Ok(());
    }
    // 2. Another token's entry holds the grain this one would take.
    if exists(
        "SELECT EXISTS(SELECT 1 FROM deck_token_printings
                        WHERE deck_id = ?1 AND variant = ?2 AND card_id = ?3 AND finish = ?4)",
        &[deck_id, &variant, card_id, &finish],
    )? {
        return Ok(());
    }
    let name = format!("{uid}-{variant}");
    // 3. The entry an earlier conversion made from this pick, moved to the new art.
    let moved = tx
        .execute(
            "UPDATE deck_token_printings
                SET card_id = ?2, finish = ?3, updated_at = unixepoch()
              WHERE sync_uid = ?1",
            params![name, card_id, finish],
        )
        .map_err(|e| e.to_string())?;
    if moved > 0 {
        return Ok(());
    }
    // 4. A new entry.
    tx.execute(
        "INSERT INTO deck_token_printings
             (deck_id, variant, oracle_id, card_id, finish, quantity, created_at, updated_at,
              sync_uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch(), ?7)",
        params![
            deck_id,
            variant,
            oracle_id,
            card_id,
            finish,
            quantity.unwrap_or(1).max(0),
            name
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// **The launch-time repair behind the v52 conversion**, idempotent: every entry whose finish its
/// printing is not sold in moves to the printing's [`default_finish`] — its sole finish, for a
/// foil-only or etched-only printing.
///
/// **It is the net under [`convert_legacy_picks`], no longer the half of it.** The conversion files
/// each v51 pick in its printing's own [`default_finish`], read from the corpus; it falls back to
/// `nonfoil` only where this device's corpus cannot say — the printing absent, or its `finishes`
/// unreadable — and those are the entries this moves, at the first launch after a sync brings the
/// printing. The other population is a printing whose sold finishes change after its entry was
/// filed, which no write can foresee. (Until 2026-09-26 the v52 rung did the converting, wrote
/// `nonfoil` for every art because **no migration rung reads the corpus** — `migrate_user` runs
/// before `migrate_corpus` — and this was the other half of every conversion.) The reader can
/// never have chosen such a finish — the picker only offers what is sold — so this touches only
/// what nothing could decide at write time. A printing that has left the corpus, or whose
/// `finishes` says nothing, is left alone.
///
/// **The entry keeps its row, and so its `sync_uid`.** Where the target finish is free in that
/// list the finish is rewritten **in place** (`UPDATE … WHERE id`), never deleted and inserted
/// again: the capture triggers' uid mint sits inside the same guard `suppressed` switches off, so
/// a re-inserted row would come back with no name, and the next captured write to it — a stepper,
/// whose update trigger has no uid guard — would put a NULL into `sync_ops.uid NOT NULL` and fail
/// on every press from then on. Every device runs the same repair over the same rows, so the name
/// the conversion gave the entry stays the name every peer knows it by.
///
/// **A repair that lands on an entry the list already holds folds into it**, on the grain,
/// rather than failing the launch on the unique index: the held row takes the quantity and keeps
/// its own name, and the repaired row is deleted — an `UPDATE` and a `DELETE`, neither of which
/// needs a uid minted. **The walk is in `sync_uid` order, so where one list holds two wrong
/// finishes of one printing the lower uid is the one kept** — `sync_engine::apply`'s `min` rule.
/// Both move to the one right finish; the first moved keeps its row and the second folds into
/// it, so walked in each device's own row order two devices could keep the entry under two names,
/// and each would then hold a row the other's edits cannot find.
///
/// **Behind `capture::suppressed`**, `apps/desktop/src-tauri/CLAUDE.md`'s rule for a write every device
/// derives for itself: whether a printing is foil-only is a fact of *this* device's corpus, each
/// device repairs its own rows, and a captured fold would arrive on the other device as a second
/// sum. `the_finish_repair_keeps_the_entrys_uid_and_a_later_step_is_captured` is the paired
/// fixture that holds the name. **The one cost of settling a finish per device** survives only on
/// the fallback: a peer whose corpus lacked the printing announced `nonfoil`, and its put landing
/// here after this repair, with a later stamp than this device's own announcement, writes the
/// guess back until the next launch repairs it again, uncaptured as before. A conversion on a
/// device whose corpus holds the printing announces the right finish and costs nothing here.
pub fn repair_entry_finishes(conn: &Connection) -> Result<(), String> {
    // `(id, deck, variant, card, quantity, the finish it should be)`.
    type Wrong = (i64, i64, String, String, i64, &'static str);
    let wrong: Vec<Wrong> = {
        let mut stmt = conn
            .prepare(
                "SELECT e.id, e.deck_id, e.variant, e.card_id, e.finish, e.quantity, c.finishes
                   FROM deck_token_printings e
                   JOIN cards c ON c.id = e.card_id
                  ORDER BY e.sync_uid",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (id, deck_id, variant, card_id, finish, quantity, finishes) =
                row.map_err(|e| e.to_string())?;
            let sold = offered(finishes.as_deref());
            if sold.is_empty() || sold.contains(&finish.as_str()) {
                continue;
            }
            out.push((id, deck_id, variant, card_id, quantity, sold[0]));
        }
        out
    };
    if wrong.is_empty() {
        return Ok(());
    }
    crate::sync_engine::capture::suppressed(conn, || {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (id, deck_id, variant, card_id, quantity, finish) in &wrong {
            let held: Option<i64> = tx
                .query_row(
                    "SELECT id FROM deck_token_printings
                      WHERE deck_id = ?1 AND variant = ?2 AND card_id = ?3 AND finish = ?4",
                    params![deck_id, variant, card_id, finish],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match held {
                Some(held) => {
                    tx.execute(
                        "UPDATE deck_token_printings
                            SET quantity = quantity + ?2, updated_at = unixepoch()
                          WHERE id = ?1",
                        params![held, quantity],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.execute(
                        "DELETE FROM deck_token_printings WHERE id = ?1",
                        params![id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                None => {
                    tx.execute(
                        "UPDATE deck_token_printings
                            SET finish = ?2, updated_at = unixepoch()
                          WHERE id = ?1",
                        params![id, finish],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())
    })
}

/// **The launch pass that retires a dismissal** (user schema v55, the token-improvements spec
/// §3.3): every token still `hidden` comes back as an ordinary token **at zero, its printings
/// kept** — the reader's own rule, and the whole of what this does. Per token:
///
/// 1. **Its entries' quantities go to zero** in both lists, at the printings they name.
/// 2. **So does its legacy count**: `deck_tokens.quantity` is `NULL` where the row carries no pick
///    and `0` where a v51 pick still waits for conversion. [`write_state`] alone keeps a legacy
///    count — a dismissed Treasure counted at 3 before v52 would come back at 3 in every list with
///    no entries — and a paired device climbing from v51 runs this pass *before* the pull that
///    converts its picks, at `quantity ?? 1`; the `0` is what makes those entries arrive at zero.
///    ([`clear_legacy_count`], which a write that settles a `hidden` sooner runs too.)
/// 3. **Its state becomes `auto` where the deck still makes the token** — in either list,
///    because the state is shared by both — **or where it holds nothing**, and `manual` where it
///    holds an entry or a pick nothing makes, through [`write_state`]. A dismissed Treasure the
///    deck makes is then no row at all; a dismissed token nothing makes stays on the wall as the
///    reader's own, at zero, in the lists that hold it; and one nothing makes or holds is gone,
///    where `manual` would be a row drawn in no list.
///
/// **A pass and not a rung**, because whether the deck still makes the token is [`derive`]'s
/// answer, which reads `cards.raw`, and no rung reads the corpus — `migrate_user` runs before
/// `migrate_corpus`. `schema::prepare_database` runs it after [`repair_entry_finishes`] and
/// `deck_meta::refile_stray_theory_cards_at_launch`, logged and left owing like them
/// ([`retire_hidden_logged`]), and then drains the marks every one of those passes left —
/// [`reconcile_dirty_logged`] and the managed wishlist's settle — so the first v55 launch settles
/// each theory deck's managed wishlist on the zeroed counts rather than before them.
///
/// **Behind `capture::suppressed`**, `apps/desktop/src-tauri/CLAUDE.md`'s rule for a write every device
/// derives for itself: each device retires the same synced rows over the same corpus to the same
/// answer, so there is nothing to announce — and an announced zero would reach a peer still on
/// v54 as a count nobody set there. The entries are rewritten **in place**, for
/// [`repair_entry_finishes`]' reason: each keeps its row and its `sync_uid`, so the next captured
/// step on it names the row every peer holds.
///
/// **Idempotent, which is what Review Focus 1 rests on.** A `hidden` that arrives by sync after
/// the pass has run — an older peer's dismissal — draws as an ordinary token, because no reader
/// treats the word as hidden any more, until the next launch retires it here. A database with
/// nothing dismissed costs one read.
///
/// ⚠️ **A token the pass cannot prove unmade waits.** Where no list derives the token and a list
/// has a maker this corpus cannot read ([`Derivation::unreadable`]) — a device synced before its
/// corpus downloaded — `manual` would be a guess, and a wrong one keeps the token's entries from
/// every reconcile after its maker is cut. So that token is left as it is, entries and all, for a
/// launch whose corpus can answer: retired whole or not at all. One the deck provably still makes
/// is retired whatever else in the deck is unreadable.
///
/// **One savepoint per token** ([`one_row`]), [`convert_legacy_picks`]' shape: a token whose
/// derivation or write fails is rolled back to its own savepoint, written to stderr and left
/// `hidden` for the next launch, and every other token is still retired.
pub fn retire_hidden(conn: &Connection) -> Result<(), String> {
    let hidden: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT deck_id, oracle_id FROM deck_tokens
                  WHERE state = ?1
                  ORDER BY deck_id, oracle_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![HIDDEN_STATE], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?
    };
    if hidden.is_empty() {
        return Ok(());
    }
    crate::sync_engine::capture::suppressed(conn, || {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        // One derivation per list per deck, however many of its tokens were dismissed. A
        // derivation is a read, so one cached before a later token's savepoint rolled back is
        // still true.
        let mut derived: Derivations = HashMap::new();
        for (deck_id, oracle_id) in &hidden {
            let retired = one_row(&tx, || retire_one(&tx, &mut derived, *deck_id, oracle_id));
            if let Err(e) = retired {
                eprintln!(
                    "a dismissed token (deck {deck_id}, token {oracle_id}) could not be brought \
                     back at launch: {e}\nIt is tried again at the next launch, and draws as an \
                     ordinary token until then; every other dismissed token was tried on its own."
                );
            }
        }
        tx.commit().map_err(|e| e.to_string())
    })
}

/// [`retire_hidden`]'s cache: one [`Derivation`] per deck per list.
type Derivations = HashMap<(i64, &'static str), Derivation>;

/// One dismissal, retired — [`retire_hidden`]'s three steps, or nothing where the token cannot be
/// proved unmade.
fn retire_one(
    tx: &Connection,
    derived: &mut Derivations,
    deck_id: i64,
    oracle_id: &str,
) -> Result<(), String> {
    let (mut made, mut unsure) = (false, false);
    for variant in crate::schema::DECK_VARIANTS {
        let derivation = match derived.entry((deck_id, variant)) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => e.insert(derive(tx, deck_id, variant)?),
        };
        made |= derivation.tokens.contains_key(oracle_id);
        unsure |= derivation.unreadable;
    }
    if !made && unsure {
        return Ok(());
    }
    tx.execute(
        "UPDATE deck_token_printings SET quantity = 0, updated_at = unixepoch()
          WHERE deck_id = ?1 AND oracle_id = ?2",
        params![deck_id, oracle_id],
    )
    .map_err(|e| e.to_string())?;
    clear_legacy_count(tx, deck_id, oracle_id)?;
    // A pick still waiting for conversion counts as held: it becomes the token's entries.
    let held: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_token_printings
                            WHERE deck_id = ?1 AND oracle_id = ?2)
                 OR EXISTS(SELECT 1 FROM deck_tokens
                            WHERE deck_id = ?1 AND oracle_id = ?2 AND card_id IS NOT NULL)",
            params![deck_id, oracle_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let state = if made || !held {
        AUTO_STATE
    } else {
        MANUAL_STATE
    };
    write_state(tx, deck_id, oracle_id, state)
}

/// [`retire_hidden`] with its failure written to stderr rather than returned — what
/// `schema::prepare_database` calls, [`reconcile_dirty_logged`]'s shape, because a dismissal not
/// yet retired draws as an ordinary token anyway and is tried again at the next launch: nothing a
/// reader could act on is gained by refusing to start over one.
pub fn retire_hidden_logged(conn: &Connection) {
    if let Err(e) = retire_hidden(conn) {
        eprintln!(
            "the decks' dismissed tokens could not be brought back at launch: {e}\nThey are \
             tried again at the next launch; until then each draws as an ordinary token."
        );
    }
}

// ---------------------------------------------------------------------------------------
// Every token in the game — the picker's All tokens
// ---------------------------------------------------------------------------------------

/// One paper printing of a token or an emblem, **anywhere in the corpus** — a row of
/// [`list_token_printings`], what Add printing's **All tokens** lists (the token-improvements spec
/// §3.6).
///
/// **The printings picker's own [`crate::card::Printing`], flattened**, so its tile code draws
/// one of these without a branch — finish prices, picture and chin included — with the token's
/// facts beside it: the `oracle_id` the picker groups by and a pick is filed under, the name its
/// group heading reads, and the fields `deckTokens.ts`' `tokenSubtitle` tells two `Wurm`s apart
/// by, the same ones [`DeckTokenRow`] carries (`typeLine` among them, because that function's
/// argument type names it).
///
/// **No `layout` of its own**: the printing's is on the wire already, and a field of the same
/// name beside a flattened struct would write the key twice.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPrinting {
    pub oracle_id: String,
    pub name: String,
    pub type_line: Option<String>,
    /// Concatenated letters, [`DeckTokenRow::colors`]' shape.
    pub colors: Option<String>,
    /// A string, [`DeckTokenRow::power`]'s reason.
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub oracle_text: Option<String>,
    #[serde(flatten)]
    pub printing: crate::card::Printing,
}

/// A list of words as the SQL literals an `IN (…)` takes — [`crate::sorting::finish_literals`]'
/// rule, so the layout lists below are [`TOKEN_LAYOUTS`] and [`TWO_SIDED_LAYOUTS`] themselves
/// rather than a second spelling of them.
fn sql_words(words: &[&str]) -> String {
    words
        .iter()
        .map(|w| format!("'{w}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// **Every paper printing [`is_listed_token`] answers yes for**, priced at `market` — the All
/// tokens toggle's list, grouped by token: ordered by name, then `oracle_id` (two tokens can share
/// a name), then newest printing first by `list_printings`' own tail.
///
/// **One statement with the predicate in SQL**, both of [`is_listed_token`]'s arms: a token or
/// two-sided layout with a type line — or any ` // ` face of it — beginning `Token` or `Emblem`;
/// or a game helper, a [`HELPER_LAYOUTS`] row outside a set of [`OTHER_GAME_SET_TYPES`] with a
/// face that is exactly [`HELPER_FACE`] and no [`CHECKLIST_WORDS`], or with [`FACE_DOWN_WORDS`] in
/// its text. `token_printings_answers_every_token_and_nothing_else` and
/// `token_printings_keeps_the_game_helpers_and_leaves_out_other_games` hold the SQL to the Rust
/// function over fixtures of every shape, so the two cannot come to disagree about what the picker
/// offers. `LIKE` is ASCII-case-insensitive where `starts_with` is not, and on the debug corpus
/// that changes nothing (checked with a case-sensitive `GLOB`, `node:sqlite`, 2026-09-27); the
/// helper arm is `instr`, case-sensitive like its Rust.
///
/// **The set type is a correlated `NOT EXISTS` rather than a join**: `sets` is a thousand rows keyed
/// by code, so each helper row is one primary-key lookup of its own set — and a card whose set
/// `sets` does not list is kept, as a helper in doubt is. **Never a `NOT IN` over the other games'
/// codes**: `sets.code` is a `TEXT PRIMARY KEY` without `NOT NULL`, and one row holding a NULL code
/// makes `x NOT IN (…)` NULL for every `x`, which dropped every helper while [`is_listed_token`]
/// kept them (`token_printings_keeps_the_helpers_when_a_set_has_no_code`).
///
/// **The list, measured over a copy of the debug corpus on 2026-09-28**: 3 303 printings over 1 096
/// oracle ids while the layout decided alone; 3 023 over 911 for one day, when only a `Token` or
/// `Emblem` face was listed and the live pass's World Championships ads went with every helper; and
/// **3 110 over 940** with the game helpers back — 87 printings of 29 helpers returned, and the
/// 193 still left out are the other games' cards, the minigames and the checklists.
///
/// **No index is added**, because this runs on a press and not per keystroke: the toggle asks
/// once and the picker's search box narrows the answer in the page. **And `NOT INDEXED` keeps
/// SQLite from the plan it picks unasked**, which walks `idx_cards_name` to skip the sort and pays
/// a table lookup for each of the corpus's 118 610 rows: a plain scan with a sort of the ~3 300
/// matches was faster in both paired runs on that corpus the same day — ~0.7 s against 3–6 s, and
/// ~2.4 s against 4–55 s — on a machine busy enough that the absolute figures are noise and only
/// the order is worth quoting.
///
/// A row with no `oracle_id` is skipped — [`printing_from`]'s fence, around a case that does not
/// occur — because it could not be filed as an entry of any token.
pub fn list_token_printings(
    conn: &Connection,
    market: Marketplace,
) -> Result<Vec<TokenPrinting>, String> {
    /// The token's own columns, in front of [`crate::card::printing_columns`] so that list's
    /// reader starts at a fixed offset, the one [`crate::card::printing_row`] is handed.
    const PRINTING_AT: usize = 7;
    let lines = TOKEN_LINE_WORDS
        .iter()
        .map(|word| format!("c.type_line LIKE '{word}%' OR c.type_line LIKE '% // {word}%'"))
        .collect::<Vec<_>>()
        .join(" OR ");
    // `' // ' || line || ' // '` holds ` // Card // ` exactly when one face is `Card` — the
    // Rust's `split(" // ").any(…)` without a JSON parse or a recursive query.
    let sql = format!(
        "SELECT c.oracle_id, c.name, c.type_line, c.colors, c.power, c.toughness, c.oracle_text,
                {printing}
           FROM cards c NOT INDEXED
          WHERE c.is_paper = 1
            AND ((c.layout IN ({tokens}, {two_sided}) AND ({lines}))
                 OR (c.layout IN ({helpers})
                     AND NOT EXISTS
                         (SELECT 1 FROM sets s
                           WHERE s.code = c.set_code AND s.set_type IN ({other_games}))
                     AND ((instr(' // ' || COALESCE(c.type_line, '') || ' // ',
                                 ' // {helper_face} // ') > 0
                           AND instr(COALESCE(c.oracle_text, ''), '{checklist}') = 0)
                          OR instr(' // ' || COALESCE(c.type_line, ''), ' // {dungeon}') > 0
                          OR instr(COALESCE(c.oracle_text, ''), '{face_down}') > 0)))
          ORDER BY c.name, c.oracle_id, c.released_at DESC, c.set_code, c.collector_number, c.id",
        printing = crate::card::printing_columns(market),
        tokens = sql_words(&TOKEN_LAYOUTS),
        two_sided = sql_words(&TWO_SIDED_LAYOUTS),
        helpers = sql_words(&HELPER_LAYOUTS),
        other_games = sql_words(&OTHER_GAME_SET_TYPES),
        helper_face = HELPER_FACE,
        dungeon = DUNGEON_FACE,
        checklist = CHECKLIST_WORDS,
        face_down = FACE_DOWN_WORDS,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let oracle_id: Option<String> = r.get(0)?;
            let Some(oracle_id) = oracle_id.filter(|o| !o.trim().is_empty()) else {
                return Ok(None);
            };
            Ok(Some(TokenPrinting {
                oracle_id,
                name: r.get(1)?,
                type_line: r.get(2)?,
                colors: r.get(3)?,
                power: r.get(4)?,
                toughness: r.get(5)?,
                oracle_text: r.get(6)?,
                printing: crate::card::printing_row(r, PRINTING_AT)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.extend(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use rusqlite::{params, Connection};
    use serde_json::json;

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

    /// The live list, which is what every test below but one is about — priced at TCGplayer,
    /// `Marketplace::from_opt`'s default, since most of them are not about the price.
    fn rows(conn: &Connection, deck: i64) -> Vec<DeckTokenRow> {
        deck_token_rows(conn, deck, "live", Marketplace::Tcgplayer)
            .expect("the resolver must never answer Err")
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
            (
                row.card_id.as_str(),
                row.finish.as_str(),
                row.quantity,
                row.state.as_str(),
                row.implicit
            ),
            (treasure().id, "nonfoil", 0, "auto", true),
            "nothing stored is the implicit entry — the default printing in its default finish, \
             at zero, `auto` — never a null"
        );
    }

    // ── Game markers (#670) ───────────────────────────────────────────────────────────

    /// `Palace Jailer` — a monarch maker whose `all_parts` names no helper at all.
    fn palace_jailer() -> Card<'static> {
        Card {
            id: "c-jailer",
            oracle_id: "o-jailer",
            name: "Palace Jailer",
            type_line: "Creature — Human Soldier",
            colors: "W",
            oracle_text: "When Palace Jailer enters, you become the monarch.\nWhen Palace Jailer \
                          enters, exile target creature an opponent controls until an opponent \
                          becomes the monarch.",
            ..Card::default()
        }
    }

    /// The Monarch in a token set — the helper a monarch maker credits.
    fn the_monarch() -> Card<'static> {
        Card {
            id: "c-monarch",
            oracle_id: "o-monarch",
            name: "The Monarch",
            type_line: "Card",
            layout: "token",
            oracle_text: "At the beginning of your end step, draw a card.\nWhenever a creature \
                          deals combat damage to you, its controller becomes the monarch.",
            set_code: "tcn2",
            released_at: "2018-08-09",
            ..Card::default()
        }
    }

    fn sources_of(row: &DeckTokenRow) -> Vec<&str> {
        row.sources.iter().map(|s| s.name.as_str()).collect()
    }

    /// **A card that makes its controller the monarch derives The Monarch** — out of its text,
    /// with nothing in `all_parts`, and in the token-set printing rather than a newer one from a
    /// World Championships deck, which [`marker_printings`] leaves out as All tokens does.
    #[test]
    fn a_monarch_maker_derives_the_monarch() {
        let conn = open();
        conn.execute(
            "INSERT INTO sets (code, name, set_type) VALUES ('wc99', 'wc99', 'memorabilia')",
            [],
        )
        .unwrap();
        palace_jailer().insert(&conn);
        the_monarch().insert(&conn);
        Card {
            id: "c-monarch-wc",
            set_code: "wc99",
            released_at: "2024-01-01",
            ..the_monarch()
        }
        .insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &palace_jailer(), "live");

        let out = rows(&conn, deck);
        assert_eq!(names(&out), vec!["The Monarch"]);
        assert_eq!(
            out[0].default_card_id, "c-monarch",
            "never another game's copy"
        );
        assert_eq!(out[0].oracle_id, "o-monarch");
        assert!(out[0].derived, "made by the deck, not added by hand");
        assert_eq!(sources_of(&out[0]), vec!["Palace Jailer"]);
    }

    /// **The text is read off every face** — the column is NULL for a two-faced card, so a
    /// tempt on the back face must still be found, and a curly apostrophe must still match.
    #[test]
    fn a_marker_on_a_back_face_is_found() {
        let conn = open();
        let maker = Card {
            id: "c-dfc-maker",
            oracle_id: "o-dfc-maker",
            name: "Front // Back",
            layout: "transform",
            ..Card::default()
        };
        let blob = json!({
            "id": maker.id,
            "name": maker.name,
            "card_faces": [
                { "name": "Front", "oracle_text": "Ascend (you get the city\u{2019}s blessing)" },
                { "name": "Back", "oracle_text": "Whenever this attacks, the Ring tempts you." },
            ],
        });
        maker.insert_raw(&conn, &crate::card_row::gzip_raw(&blob.to_string()));
        for (id, name, set_code) in [
            ("c-ring", "The Ring", "tltr"),
            ("c-blessing", "City's Blessing", "trix"),
        ] {
            Card {
                id,
                oracle_id: id,
                name,
                type_line: "Card",
                layout: "token",
                set_code,
                ..Card::default()
            }
            .insert(&conn);
        }
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &maker, "live");

        assert_eq!(
            names(&rows(&conn, deck)),
            vec!["City's Blessing", "The Ring"]
        );
    }

    /// **Venturing brings every dungeon the corpus holds**, one tile each, and a dungeon it does
    /// not hold is simply absent — never an error, never a hole.
    #[test]
    fn venturing_brings_every_dungeon_in_the_corpus() {
        let conn = open();
        let maker = Card {
            id: "c-venturer",
            oracle_id: "o-venturer",
            name: "Dungeon Crawler",
            oracle_text: "When this enters, venture into the dungeon.",
            ..Card::default()
        };
        maker.insert(&conn);
        for (id, name) in [
            ("c-lost-mine", "Lost Mine of Phandelver"),
            ("c-tomb", "Tomb of Annihilation"),
        ] {
            Card {
                id,
                oracle_id: id,
                name,
                type_line: "Dungeon",
                layout: "token",
                set_code: "tafr",
                ..Card::default()
            }
            .insert(&conn);
        }
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &maker, "live");

        let out = rows(&conn, deck);
        assert_eq!(
            names(&out),
            vec!["Lost Mine of Phandelver", "Tomb of Annihilation"]
        );
        assert!(out.iter().all(|r| sources_of(r) == vec!["Dungeon Crawler"]));
    }

    /// **One maker naming a helper twice is one source** — once in `all_parts` and once in its
    /// text — and a helper the corpus does not hold derives nothing at all.
    #[test]
    fn a_marker_named_twice_is_one_source_and_an_absent_helper_is_nothing() {
        let conn = open();
        let both = Card {
            id: "c-both",
            oracle_id: "o-both",
            name: "Both Ways",
            oracle_text: "When this enters, you become the monarch.",
            parts: &[("c-monarch", "token", "The Monarch")],
            ..Card::default()
        };
        both.insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &both, "live");
        assert!(
            rows(&conn, deck).is_empty(),
            "no Monarch in the corpus: nothing, and no Err"
        );

        the_monarch().insert(&conn);
        let out = rows(&conn, deck);
        assert_eq!(names(&out), vec!["The Monarch"]);
        assert_eq!(
            sources_of(&out[0]),
            vec!["Both Ways"],
            "one source, not two"
        );
    }

    /// **A marker is read only off the deck's active piles**, like every token: the Maybeboard
    /// counts toward nothing, and makes its controller the monarch no more than it makes a
    /// Treasure.
    #[test]
    fn a_marker_on_the_maybeboard_derives_nothing() {
        let conn = open();
        palace_jailer().insert(&conn);
        the_monarch().insert(&conn);
        let (deck, _, maybe) = deck_with_piles(&conn);
        play(&conn, deck, maybe, &palace_jailer(), "live");
        assert!(rows(&conn, deck).is_empty());
    }

    // ── The chin and the price ────────────────────────────────────────────────────────

    /// The chin a pile draws under each token — set, number, rarity — and the figure its
    /// heading sums, all off the printing the tile draws.
    #[test]
    fn a_resolved_token_carries_its_printings_chin_and_price() {
        let conn = open();
        let (deck, main, _) = deck_with_piles(&conn);
        tithe().insert(&conn);
        treasure().insert(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
        let t = rows.iter().find(|r| r.name == "Treasure").unwrap();
        assert_eq!(t.set_code.as_deref(), Some(treasure().set_code));
        assert_eq!(
            t.collector_number.as_deref(),
            Some(treasure().collector_number)
        );
        assert_eq!(t.set_name.as_deref(), Some("Commander Masters Tokens"));
        assert_eq!(t.rarity.as_deref(), Some("common"));
        assert_eq!(t.finishes.as_deref(), Some(r#"["nonfoil"]"#));
        assert_eq!(t.unit_price, Some(0.25));
    }

    /// **A foil-only printing is priced at its foil rate, never read as unpriced** — reading
    /// `$.usd` alone is the bug `sorting::printing_price_by_finish_expr` documents for 13 515
    /// foil-only printings, and that chain is what prices a token.
    #[test]
    fn a_foil_only_token_is_priced_at_its_foil_price() {
        let conn = open();
        let (deck, main, _) = deck_with_piles(&conn);
        tithe().insert(&conn);
        Card {
            finishes: r#"["foil"]"#,
            prices: r#"{"usd":null,"usd_foil":"3.10"}"#,
            ..treasure()
        }
        .insert(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
        let t = rows.iter().find(|r| r.name == "Treasure").unwrap();
        assert_eq!(t.unit_price, Some(3.10));
        assert_eq!(t.finishes.as_deref(), Some(r#"["foil"]"#));
    }

    /// **An entry is priced at its own finish, and never down a chain** — the case where the
    /// deck's `nonfoil → foil → etched` chain and a finish part company: a printing listed in
    /// both finishes whose nonfoil is unpriced. The implicit entry is the nonfoil, and a nonfoil
    /// with no price is an em dash — quoting the foil's rate for it is the bug
    /// `row_price_expr`'s named arm refuses for a deck row that says its finish. A foil entry of
    /// the same printing is the foil's rate.
    ///
    /// Held to the crate's own expression rather than to a literal alone, so the two cannot drift.
    #[test]
    fn an_entry_is_priced_at_its_own_finish_and_never_down_a_chain() {
        let conn = open();
        let (deck, main, _) = deck_with_piles(&conn);
        tithe().insert(&conn);
        Card {
            finishes: r#"["nonfoil","foil"]"#,
            prices: r#"{"usd":null,"usd_foil":"2.40"}"#,
            ..treasure()
        }
        .insert(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
        assert_eq!(rows[0].finish, "nonfoil");
        assert_eq!(
            rows[0].unit_price, None,
            "an unpriced nonfoil, not the foil's rate"
        );
        assert_eq!(
            rows[0].finishes.as_deref(),
            Some(r#"["nonfoil","foil"]"#),
            "and the finishes reach the chin unchanged — what the picker offers"
        );

        seed_entry(&conn, deck, "live", &treasure(), "foil", 1);
        let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
        let foil_figure: Option<f64> = conn
            .query_row(
                &format!(
                    "SELECT {} FROM cards c WHERE c.id = ?1",
                    crate::sorting::price_expr(Marketplace::Tcgplayer, "'foil'")
                ),
                params![treasure().id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows[0].unit_price, Some(2.40));
        assert_eq!(
            rows[0].unit_price, foil_figure,
            "the collection's own foil figure"
        );
    }

    /// Unpriced is `None` and never `0` — the heading's sum skips it, and a zero would be a
    /// free card in the total. Common on Card Kingdom and Mana Pool.
    #[test]
    fn an_unpriced_token_answers_none_rather_than_zero() {
        let conn = open();
        let (deck, main, _) = deck_with_piles(&conn);
        tithe().insert(&conn);
        Card {
            prices: "{}",
            ..treasure()
        }
        .insert(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            rows.iter()
                .find(|r| r.name == "Treasure")
                .unwrap()
                .unit_price,
            None
        );
    }

    /// **The chin follows the entry's printing** — and a printing that has left the corpus has no
    /// chin, rather than the resolver's printing wearing its place.
    #[test]
    fn an_entrys_printing_brings_its_own_chin_and_price() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure_older(), "nonfoil", 1);

        let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
        assert_eq!(rows[0].default_card_id, treasure().id);
        assert_eq!(
            (
                rows[0].set_code.as_deref(),
                rows[0].collector_number.as_deref(),
                rows[0].set_name.as_deref(),
                rows[0].unit_price,
            ),
            (
                Some("tvow"),
                Some("17"),
                Some("Crimson Vow Tokens"),
                Some(1.50)
            ),
            "the printing the tile draws, not the one the resolver named"
        );

        conn.execute(
            "UPDATE deck_token_printings SET card_id = 'c-vanished' WHERE deck_id = ?1",
            params![deck],
        )
        .unwrap();
        let gone = &deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap()[0];
        assert_eq!(
            (
                gone.set_code.as_deref(),
                gone.collector_number.as_deref(),
                gone.set_name.as_deref(),
                gone.rarity.as_deref(),
                gone.finishes.as_deref(),
                gone.unit_price,
            ),
            (None, None, None, None, None, None),
            "a printing that has left the corpus has no chin"
        );
    }

    /// The marketplace argument reaches the price — Cardmarket reads the euro keys of the same
    /// blob, so a figure that ignored it would quote dollars under a euro sign.
    #[test]
    fn the_price_is_the_asked_marketplaces() {
        let conn = open();
        let (deck, main, _) = deck_with_piles(&conn);
        tithe().insert(&conn);
        Card {
            prices: r#"{"usd":"0.25","eur":"0.40"}"#,
            ..treasure()
        }
        .insert(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let price = |market| deck_token_rows(&conn, deck, "live", market).unwrap()[0].unit_price;
        assert_eq!(price(Marketplace::Tcgplayer), Some(0.25));
        assert_eq!(price(Marketplace::Cardmarket), Some(0.40));
        assert_eq!(
            price(Marketplace::Cardkingdom),
            None,
            "a feed with no row for the printing is unpriced there, never another shop's figure"
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
                deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer),
                Ok(Vec::new()),
                "{why} must answer an empty list rather than an Err"
            );
            conn.execute("DELETE FROM deck_cards WHERE card_id = ?1", params![id])
                .unwrap();
        }

        assert_eq!(
            deck_token_rows(&conn, 9999, "live", Marketplace::Tcgplayer),
            Ok(Vec::new()),
            "a deck that is not there has no tokens, which is an answer"
        );
    }

    /// One `deck_tokens` row written straight into the table, legacy columns and all.
    fn seed_state(conn: &Connection, deck: i64, oracle: &str, quantity: Option<i64>, state: &str) {
        conn.execute(
            "INSERT INTO deck_tokens (deck_id, oracle_id, quantity, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, 0)",
            params![deck, oracle, quantity, state],
        )
        .unwrap();
    }

    /// What a hook test asserts after one Ctrl+Z on the cut: both entries back, and the Treasure
    /// the deck's own again — no `deck_tokens` row.
    fn assert_restored_as_auto(conn: &Connection, deck: i64, context: &str) {
        assert_eq!(
            entries(conn, deck).len(),
            2,
            "one Ctrl+Z brings both entries back — {context}"
        );
        assert_eq!(
            state_word(conn, deck, treasure().oracle_id),
            None,
            "and the Treasure back to `auto` — {context}"
        );
    }

    /// A deck whose live main pile plays `Smothering Tithe`, with both Tithe printings and both
    /// Treasures in the corpus — the fixture every write test below starts from. The Tithe's own
    /// self-entry names its other printing, and that printing is inserted so the list's makers
    /// all read: a reconcile over an unreadable list deletes nothing.
    fn tithe_deck(conn: &Connection) -> (i64, i64, i64) {
        tithe().insert(conn);
        tithe_other_printing().insert(conn);
        treasure().insert(conn);
        treasure_older().insert(conn);
        let (deck, main, maybe) = deck_with_piles(conn);
        play(conn, deck, main, &tithe(), "live");
        (deck, main, maybe)
    }

    fn treasure_key(card: &Card<'_>, finish: &str) -> TokenEntryKey {
        TokenEntryKey {
            card_id: card.id.to_owned(),
            finish: finish.to_owned(),
        }
    }

    // ── Rule 1: one row per entry, or one implicit row ───────────────────────────────

    /// **A token with no entries draws one implicit entry** — the resolver's default printing, in
    /// its default finish, at `deck_tokens.quantity ?? 0`.
    #[test]
    fn a_derived_token_with_no_entries_yields_one_implicit_row() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert!(out[0].implicit);
        assert_eq!(out[0].card_id, treasure().id, "the default printing");
        assert_eq!(out[0].card_id, out[0].default_card_id);
        assert_eq!(out[0].finish, "nonfoil");
        assert_eq!(out[0].quantity, 0, "no legacy quantity, so none");
        assert_eq!(out[0].state, "auto", "no row is `auto`, never a null");
    }

    /// **An untouched token reads zero, and the first step writes one** (the token-improvements
    /// spec §3.1): a token is something the reader starts to use, so nothing is counted until
    /// they count it — and the `+` that does is the write that materialises the entry.
    #[test]
    fn an_untouched_token_reads_zero_and_its_first_step_writes_one() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        let out = rows(&conn, deck);
        assert_eq!(
            (out.len(), out[0].implicit, out[0].quantity),
            (1, true, 0),
            "the Tithe makes a Treasure, and nobody has counted one yet"
        );

        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 1).unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 1)],
            "one entry, at one, at the printing the reader was looking at"
        );
    }

    /// **A legacy quantity is still honoured** — a pre-v52 override that named no printing is the
    /// count the reader set, and the new default is only what an *untouched* token reads.
    #[test]
    fn a_legacy_quantity_is_still_honoured() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_state(&conn, deck, treasure().oracle_id, Some(3), "auto");

        let out = rows(&conn, deck);
        assert_eq!((out[0].implicit, out[0].quantity), (true, 3));
    }

    /// **A hand-added token is drawn only in a list that holds an entry of it** (spec §3.4): the
    /// hand-added tail emits no implicit row for a list with none. A Soldier added to the live
    /// list is not on the plan's wall, a press naming its implicit entry there has nothing to
    /// address, and a first add there files the printing alone — where the tail's implicit row
    /// used to be materialised beside it and the add landed at two.
    #[test]
    fn a_hand_added_token_is_drawn_only_in_a_list_that_holds_an_entry_of_it() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        add_printing(&conn, deck, "live", soldier().id, None).unwrap();

        let live = rows(&conn, deck);
        assert_eq!(names(&live), vec!["Treasure", "Soldier"]);
        assert!(!live[1].derived, "the Soldier is the reader's own");
        let theory = deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer).unwrap();
        assert!(
            theory.is_empty(),
            "the plan makes nothing and holds no Soldier: {theory:?}"
        );
        assert_eq!(
            set_quantity(&conn, deck, "theory", soldier().oracle_id, None, 1),
            Err(TOKEN_GONE.to_owned()),
            "and there is no implicit Soldier in the plan to step"
        );

        assert_eq!(
            add_printing(&conn, deck, "theory", soldier().id, None).unwrap(),
            1,
            "an add in the plan is that one copy and nothing materialised beside it"
        );
        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", soldier().oracle_id, soldier().id, "nonfoil", 1),
                e("theory", soldier().oracle_id, soldier().id, "nonfoil", 1),
            ]
        );
    }

    /// An implicit entry on a foil-only printing is the foil — **its sole finish**, never a
    /// `nonfoil` it is not sold in.
    #[test]
    fn an_implicit_entry_on_a_foil_only_printing_is_the_foil() {
        let conn = open();
        tithe().insert(&conn);
        tithe_other_printing().insert(&conn);
        Card {
            finishes: r#"["foil"]"#,
            prices: r#"{"usd":null,"usd_foil":"3.10"}"#,
            ..treasure()
        }
        .insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let out = rows(&conn, deck);
        assert_eq!(out[0].finish, "foil");
        assert_eq!(
            out[0].unit_price,
            Some(3.10),
            "priced at the finish it is drawn in"
        );
    }

    /// **Two entries, two rows, and no implicit one** — adding art B keeps art A, and the
    /// token's own fields ride every row.
    #[test]
    fn a_token_with_two_entries_yields_two_rows_and_no_implicit_one() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 1);

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|r| !r.implicit));
        assert!(out
            .iter()
            .all(|r| r.oracle_id == treasure().oracle_id && r.derived));
        assert!(out.iter().all(|r| r.default_card_id == treasure().id));
        assert_eq!(
            out.iter()
                .map(|r| (r.card_id.as_str(), r.finish.as_str(), r.quantity))
                .collect::<Vec<_>>(),
            vec![
                (treasure_older().id, "foil", 1),
                (treasure().id, "nonfoil", 2),
            ],
            "the entries, in `(card_id, finish)` order"
        );
        assert_eq!(
            (out[0].set_code.as_deref(), out[0].unit_price),
            (Some("tvow"), Some(4.00)),
            "each row's chin and price are its own printing's, at its own finish"
        );
    }

    /// **Theory and live never share an entry** (rule 6): each list draws its own, and one with
    /// none is implicit whatever the other holds.
    #[test]
    fn theory_and_live_rows_differ_when_their_entries_do() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        seed_entry(&conn, deck, "theory", &treasure_older(), "foil", 3);

        let live = rows(&conn, deck);
        let theory = deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer).unwrap();
        assert!(live[0].implicit, "the live list has no entry");
        assert_eq!(
            (
                theory[0].card_id.as_str(),
                theory[0].finish.as_str(),
                theory[0].quantity
            ),
            (treasure_older().id, "foil", 3)
        );
        assert!(!theory[0].implicit);
    }

    /// A dismissed token is still answered — every one of its rows carrying `hidden` — and drawn
    /// like any other, since v55, until the next launch retires it. The state is shared by both
    /// lists.
    #[test]
    fn a_dismissed_tokens_rows_carry_its_state() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 1);
        seed_entry(&conn, deck, "live", &treasure_older(), "nonfoil", 1);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");

        let live = rows(&conn, deck);
        assert_eq!(
            live.len(),
            2,
            "Rust supplies the fact; the visibility is a conclusion"
        );
        assert!(live.iter().all(|r| r.state == "hidden"));
        let theory = deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            theory[0].state, "hidden",
            "a dismissal is \"not in this deck\""
        );
    }

    /// A `manual` token nothing derives is on the wall with its entries — and a manual token the
    /// deck *does* derive is one token, not two.
    #[test]
    fn a_manual_token_nothing_derives_yields_its_entries() {
        let conn = open();
        treasure().insert(&conn);
        treasure_older().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        seed_state(&conn, deck, treasure().oracle_id, None, "manual");
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 2);

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert!(!out[0].derived && out[0].sources.is_empty());
        assert_eq!(out[0].state, "manual");
        assert_eq!(
            (
                out[0].card_id.as_str(),
                out[0].finish.as_str(),
                out[0].quantity
            ),
            (treasure_older().id, "foil", 2)
        );
    }

    /// **Review Focus 1: a hand-added token dismissed on an older peer is still drawn** — it
    /// arrives by sync as `hidden`, nothing derives it, and it holds a live entry. The tail
    /// answers every token nothing makes whose state is not `auto`, so it draws in the list that
    /// holds it until the next launch retires the word; nothing may hide it meanwhile.
    #[test]
    fn a_dismissed_token_nothing_makes_is_drawn_where_it_holds_an_entry() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 2);

        let live = rows(&conn, deck);
        assert_eq!(names(&live), vec!["Treasure", "Soldier"]);
        assert_eq!(
            (live[1].derived, live[1].quantity, live[1].state.as_str()),
            (false, 2, "hidden")
        );
        assert!(
            deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer)
                .unwrap()
                .is_empty(),
            "and only where it holds an entry"
        );
    }

    #[test]
    fn a_manual_state_on_a_derived_token_is_not_appended_twice() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_state(&conn, deck, treasure().oracle_id, None, "manual");

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert!(out[0].derived, "the deck still makes it");
        assert_eq!(out[0].state, "manual");
    }

    /// **A token with entries that is neither derived nor `manual` draws nothing** — the stale
    /// state the reconcile exists to clear, and not something the resolver may resurrect.
    #[test]
    fn entries_of_a_token_nothing_makes_are_not_drawn() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        assert!(rows(&conn, deck).is_empty());
    }

    // ── Rule 2: the first write materialises the implicit entry ──────────────────────

    #[test]
    fn stepping_an_implicit_token_materialises_one_entry_in_that_list_only() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");

        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 3).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 3)],
            "one live entry at the default printing, and nothing in theory"
        );
        let theory = deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer).unwrap();
        assert!(theory[0].implicit && theory[0].quantity == 0);
    }

    /// An implicit entry picks up its legacy quantity when it is materialised, so the swap that
    /// makes it a stored entry does not quietly reset a reader's pre-v52 count.
    #[test]
    fn a_materialised_entry_starts_at_the_legacy_quantity() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_state(&conn, deck, treasure().oracle_id, Some(4), "auto");

        swap(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            None,
            &treasure_key(&treasure_older(), "foil"),
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "live",
                treasure().oracle_id,
                treasure_older().id,
                "foil",
                4
            )]
        );
    }

    // ── Rule 3: zero deletes, unless it is the last entry ────────────────────────────

    #[test]
    fn stepping_one_of_two_entries_to_zero_deletes_it_and_the_last_one_stays_at_zero() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 1);

        set_quantity(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            Some(&treasure_key(&treasure_older(), "foil")),
            0,
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 2)],
            "one of two stepped to nothing is gone"
        );

        set_quantity(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            Some(&treasure_key(&treasure(), "nonfoil")),
            0,
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 0)],
            "the last one stays, at zero"
        );
    }

    /// **Review Focus 1: a reader zeroes the only printing of a token** — the entry stays at
    /// zero and the implicit default does not reappear under it.
    #[test]
    fn zeroing_the_only_printing_keeps_it_at_zero_rather_than_the_default() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 0).unwrap();

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert!(
            !out[0].implicit,
            "a stored entry, not the default drawn again"
        );
        assert_eq!(out[0].quantity, 0);
    }

    #[test]
    fn a_stepper_naming_an_entry_that_is_gone_is_refused_in_words() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        assert_eq!(
            set_quantity(
                &conn,
                deck,
                "live",
                treasure().oracle_id,
                Some(&treasure_key(&treasure_older(), "foil")),
                2,
            ),
            Err(ENTRY_GONE.to_owned())
        );
        assert_eq!(
            set_quantity(&conn, deck, "live", "o-nothing-makes-this", None, 2),
            Err(TOKEN_GONE.to_owned()),
            "an implicit entry of a token that is not on the wall has nothing to materialise"
        );
        assert!(
            set_quantity(&conn, deck, "live", treasure().oracle_id, None, -1).is_err(),
            "a negative quantity is refused"
        );
        assert!(entries(&conn, deck).is_empty(), "and none of them wrote");
    }

    // ── Rule 4: a swap, and the fold ─────────────────────────────────────────────────

    #[test]
    fn swapping_the_implicit_entry_replaces_it() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        swap(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            None,
            &treasure_key(&treasure_older(), "foil"),
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "live",
                treasure().oracle_id,
                treasure_older().id,
                "foil",
                0
            )],
            "art B replaces art A at A's count, which for an untouched token is none — a swap \
             is not an add"
        );
    }

    /// **Review Focus 5: swapping onto a printing and finish the list already holds folds the
    /// two** — quantities summed, one row, one tile.
    #[test]
    fn swapping_onto_an_entry_the_list_holds_folds_the_two() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 3);

        swap(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            Some(&treasure_key(&treasure(), "nonfoil")),
            &treasure_key(&treasure_older(), "foil"),
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "live",
                treasure().oracle_id,
                treasure_older().id,
                "foil",
                5
            )]
        );
        let (_, payload) = newest_audit(&conn, deck);
        assert_eq!(payload["folded"], json!(true));
    }

    #[test]
    fn a_swap_onto_another_tokens_printing_or_an_unsold_finish_is_refused() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);

        assert_eq!(
            swap(
                &conn,
                deck,
                "live",
                treasure().oracle_id,
                None,
                &treasure_key(&soldier(), "nonfoil"),
            ),
            Err(NOT_THIS_TOKEN.to_owned())
        );
        assert_eq!(
            swap(
                &conn,
                deck,
                "live",
                treasure().oracle_id,
                None,
                &treasure_key(&treasure(), "foil"),
            ),
            Err(crate::deck::FINISH_NOT_SOLD.to_owned()),
            "the default Treasure is sold in nonfoil alone"
        );
        assert!(entries(&conn, deck).is_empty());
    }

    /// A swap onto the entry's own printing and finish is a success that writes nothing — the
    /// picker opened on an implicit tile and closed on its own art materialises nothing and
    /// records nothing.
    #[test]
    fn a_swap_onto_itself_writes_and_records_nothing() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        conn.execute("DELETE FROM deck_audit", []).unwrap();
        conn.execute(
            "UPDATE decks SET updated_at = 0 WHERE id = ?1",
            params![deck],
        )
        .unwrap();

        swap(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            None,
            &treasure_key(&treasure(), "nonfoil"),
        )
        .unwrap();
        assert!(entries(&conn, deck).is_empty());
        assert_eq!(audit_rows(&conn), 0);
        let stamped: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stamped, 0, "and the deck is not moved up a gallery for it");
    }

    /// **A dead deck hears `GONE` from every write, and before any other sentence** — the fence
    /// is a read ahead of the write, so a stale editor is not told a token or an entry has gone
    /// when it is the deck that has.
    #[test]
    fn every_token_write_refuses_a_deck_that_is_gone() {
        let conn = open();
        tithe_deck(&conn);
        let gone = Err(crate::deck::GONE.to_owned());
        assert_eq!(
            set_quantity(&conn, 9999, "live", treasure().oracle_id, None, 3),
            gone
        );
        assert_eq!(
            swap(
                &conn,
                9999,
                "live",
                treasure().oracle_id,
                Some(&treasure_key(&treasure(), "nonfoil")),
                &treasure_key(&treasure_older(), "foil"),
            ),
            gone
        );
        assert_eq!(
            remove_entry(
                &conn,
                9999,
                "live",
                treasure().oracle_id,
                &treasure_key(&treasure(), "nonfoil"),
            ),
            gone
        );
        assert_eq!(
            add_printing(&conn, 9999, "live", treasure().id, None).map(|_| ()),
            gone
        );
    }

    // ── Rule 5: adding a printing ────────────────────────────────────────────────────

    /// **Adding art B keeps art A** — the implicit entry is materialised first, at the count it
    /// was drawn at — and a second add of B steps it up.
    ///
    /// **An untouched token's implicit entry is at zero**, so the add does not materialise it —
    /// it would be one of the token's zero entries the same write clears — and B is filed alone.
    /// A legacy count is what makes A worth keeping.
    #[test]
    fn adding_a_printing_materialises_the_implicit_one_then_steps_up() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        assert_eq!(
            add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap(),
            1
        );
        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "live",
                treasure().oracle_id,
                treasure_older().id,
                "foil",
                1
            )],
            "an untouched Treasure's A was at zero, so B is filed alone"
        );
        assert_eq!(
            add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap(),
            2
        );
        assert_eq!(entries(&conn, deck)[0].4, 2);
        assert_eq!(
            stored(&conn, deck),
            vec![],
            "a token the deck derives stays `auto` — no row"
        );

        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_state(&conn, deck, treasure().oracle_id, Some(2), "auto");
        assert_eq!(
            add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap(),
            1
        );
        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure_older().id, "foil", 1),
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 2),
            ],
            "a counted A is materialised at its count and kept beside B"
        );
    }

    /// **The first add of an untouched token announces one entry and nothing else** — its implicit
    /// entry is at zero, so materialising it only to clear it in the same write would be a captured
    /// insert and delete of a row no reader ever saw, sent to every device in the group.
    #[test]
    fn adding_a_printing_to_an_untouched_token_announces_one_entry() {
        let conn = paired();
        let (deck, _, _) = tithe_deck(&conn);
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap();
        let ops: Vec<String> = recorded(&conn)
            .into_iter()
            .filter(|(t, ..)| t == "deck_token_printings")
            .map(|(_, _, kind, _)| kind)
            .collect();
        assert_eq!(ops, ["put"], "one put for the added printing");
    }

    /// **A token nothing derives becomes `manual`** — the reader's own, which no cut reconciles
    /// away — and there is no implicit entry to materialise, because it was not on the wall.
    #[test]
    fn adding_a_token_nothing_derives_makes_it_manual() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        assert_eq!(
            add_printing(&conn, deck, "live", treasure().id, None).unwrap(),
            1
        );
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 1)]
        );
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                None,
                None,
                "manual".to_owned()
            )]
        );
        assert_eq!(rows(&conn, deck).len(), 1, "and it is on the wall");
    }

    /// An add of a token still dismissed from before v55 — one the launch has not retired yet —
    /// sends it back to `auto`, where the retirement would have sent it.
    #[test]
    fn adding_a_printing_of_a_dismissed_token_restores_it() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");

        add_printing(&conn, deck, "live", treasure_older().id, Some("nonfoil")).unwrap();
        assert!(
            stored(&conn, deck).is_empty(),
            "back to `auto`, which is no row"
        );
    }

    /// **An add clears the token's zero entries in that list**, and one Undo brings them back.
    /// Rule 3 keeps a token's *last* entry at zero to mean *none*; once a second printing is
    /// added that entry is not the last any more, and left alone it is a `0` tile no stepper can
    /// send to zero again. The other list's zero entry is not this write's to clear.
    #[test]
    fn adding_a_printing_clears_the_tokens_zero_entries_in_that_list_and_undo_restores_them() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "theory", &treasure(), "nonfoil", 0);
        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 0).unwrap();
        let zeroed = vec![
            e("live", treasure().oracle_id, treasure().id, "nonfoil", 0),
            e("theory", treasure().oracle_id, treasure().id, "nonfoil", 0),
        ];
        assert_eq!(entries(&conn, deck), zeroed, "the only entry, held at zero");

        add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap();
        let added = vec![
            e("live", treasure().oracle_id, treasure_older().id, "foil", 1),
            e("theory", treasure().oracle_id, treasure().id, "nonfoil", 0),
        ];
        assert_eq!(
            entries(&conn, deck),
            added,
            "exactly one live entry remains, at one"
        );

        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_eq!(
            entries(&conn, deck),
            zeroed,
            "one Undo restores the zero entry"
        );
        crate::deck_undo::apply_reversal(&conn, deck, audit, false).unwrap();
        assert_eq!(entries(&conn, deck), added, "and Redo clears it again");
    }

    /// **A card that is not a token or an emblem is refused, and nothing is written** — Lightning
    /// Bolt handed to the band's *Add printing* would otherwise be filed as a hand-added token.
    /// The Tithe here is the deck's own maker, which is the nearest thing to a token a press
    /// could plausibly name by mistake.
    #[test]
    fn adding_a_card_that_is_not_a_token_is_refused_and_writes_nothing() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        assert_eq!(
            add_printing(&conn, deck, "live", tithe().id, None),
            Err(NOT_A_TOKEN.to_owned())
        );
        assert!(entries(&conn, deck).is_empty(), "no entry");
        assert!(stored(&conn, deck).is_empty(), "no `manual` state");
        assert_eq!(audit_rows(&conn), 0, "and no history row");
        assert_eq!(
            rows(&conn, deck).len(),
            1,
            "the wall is the Treasure the Tithe makes, and nothing else"
        );
    }

    #[test]
    fn adding_refuses_a_printing_that_is_not_there_and_a_zero() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        assert_eq!(
            add_printing(&conn, deck, "live", "c-nowhere", None),
            Err(NO_SUCH_PRINTING.to_owned())
        );
        let tx = conn.unchecked_transaction().unwrap();
        assert_eq!(
            add_printing_in(&tx, deck, "live", treasure().id, None, 0),
            Err(crate::collection::ZERO_ADD.to_owned())
        );
        drop(tx);
        assert_eq!(
            add_printing(&conn, 9999, "live", treasure().id, None),
            Err(crate::deck::GONE.to_owned()),
            "a stale editor's dead deck"
        );
        assert!(entries(&conn, deck).is_empty());
    }

    // ── Remove printing ──────────────────────────────────────────────────────────────

    /// **A derived token's entries go one at a time, the last included** — which is what a
    /// stepper never does, holding the last at zero — and a list left with none draws the
    /// implicit entry again, at zero: Reset's old answer, reached one printing at a time. The
    /// token's state is not this write's.
    #[test]
    fn removing_a_derived_tokens_last_entry_falls_back_to_its_default_printing_at_zero() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 3);

        remove_entry(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            &treasure_key(&treasure(), "nonfoil"),
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "live",
                treasure().oracle_id,
                treasure_older().id,
                "foil",
                3
            )],
            "one of two goes whatever its count, and the other is untouched"
        );

        remove_entry(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            &treasure_key(&treasure_older(), "foil"),
        )
        .unwrap();
        assert!(entries(&conn, deck).is_empty(), "the last one goes too");
        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1, "the Tithe still makes the Treasure");
        assert_eq!(
            (
                out[0].card_id.as_str(),
                out[0].finish.as_str(),
                out[0].quantity,
                out[0].implicit,
                out[0].derived
            ),
            (treasure().id, "nonfoil", 0, true, true),
            "back to the default printing, at zero"
        );
        assert!(stored(&conn, deck).is_empty(), "and the state is untouched");

        assert_eq!(
            remove_entry(
                &conn,
                deck,
                "live",
                treasure().oracle_id,
                &treasure_key(&treasure_older(), "foil"),
            ),
            Err(ENTRY_GONE.to_owned()),
            "a stale tile's second press is refused in words"
        );
    }

    /// **Review Focus 3: a hand-added token's last entry in one list goes while the other list
    /// still holds one** — it leaves this list's band only, and stays the reader's own.
    #[test]
    fn removing_a_hand_added_tokens_last_entry_in_one_list_keeps_it_in_the_other() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        add_printing(&conn, deck, "live", soldier().id, None).unwrap();
        add_printing(&conn, deck, "theory", soldier().id, None).unwrap();

        remove_entry(
            &conn,
            deck,
            "theory",
            soldier().oracle_id,
            &treasure_key(&soldier(), "nonfoil"),
        )
        .unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", soldier().oracle_id, soldier().id, "nonfoil", 1)]
        );
        assert!(
            deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer)
                .unwrap()
                .is_empty(),
            "it leaves the plan's band"
        );
        assert_eq!(
            names(&rows(&conn, deck)),
            vec!["Treasure", "Soldier"],
            "and stays on the live one's"
        );
        assert_eq!(
            stored(&conn, deck),
            vec![(
                soldier().oracle_id.to_owned(),
                None,
                None,
                "manual".to_owned()
            )],
            "still the reader's own"
        );
    }

    /// **A hand-added token's last entry anywhere takes it off the deck** — its state goes back
    /// to `auto`, which is no row, and neither list draws it.
    #[test]
    fn removing_a_hand_added_tokens_last_entry_everywhere_takes_it_off_the_deck() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        add_printing(&conn, deck, "live", soldier().id, None).unwrap();

        remove_entry(
            &conn,
            deck,
            "live",
            soldier().oracle_id,
            &treasure_key(&soldier(), "nonfoil"),
        )
        .unwrap();
        assert!(entries(&conn, deck).is_empty());
        assert!(stored(&conn, deck).is_empty(), "no `manual` row is left");
        assert_eq!(names(&rows(&conn, deck)), vec!["Treasure"]);
        assert!(
            deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer)
                .unwrap()
                .is_empty()
        );
    }

    /// **A remove is one `deck` history row and one undo step, and the undo puts the entry and
    /// the state back** — the hand-added case, because it is the one whose step has to carry the
    /// state as well. The payload names the printing by set and number, the way the drawer says
    /// it, because the history is read after the corpus has moved.
    #[test]
    fn a_remove_files_one_history_row_and_one_undo_step_that_puts_it_back() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        add_printing(&conn, deck, "live", soldier().id, None).unwrap();
        set_quantity(
            &conn,
            deck,
            "live",
            soldier().oracle_id,
            Some(&treasure_key(&soldier(), "nonfoil")),
            2,
        )
        .unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();
        let snap = |c: &Connection| (entries(c, deck), stored(c, deck));
        let before = snap(&conn);

        remove_entry(
            &conn,
            deck,
            "live",
            soldier().oracle_id,
            &treasure_key(&soldier(), "nonfoil"),
        )
        .unwrap();
        let after = snap(&conn);
        assert_eq!(after, (vec![], vec![]));

        assert_eq!(audit_rows(&conn), 1, "one history row");
        let (kind, payload) = newest_audit(&conn, deck);
        assert_eq!(kind, "deck", "a `deck` row, never a tenth kind");
        assert_eq!(
            (
                &payload["field"],
                &payload["action"],
                &payload["name"],
                &payload["oracle_id"],
                &payload["list"],
                &payload["card_id"],
                &payload["finish"],
                &payload["set_code"],
                &payload["collector_number"],
                &payload["from"],
                &payload["to"],
            ),
            (
                &json!("token"),
                &json!("remove"),
                &json!("Soldier"),
                &json!(soldier().oracle_id),
                &json!("live"),
                &json!(soldier().id),
                &json!("nonfoil"),
                &json!("tmoc"),
                &json!("8"),
                &json!(2),
                &serde_json::Value::Null,
            ),
            "the entry, the printing it was, and the copies it held"
        );
        let steps: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_undo WHERE deck_id = ?1",
                params![deck],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(steps, 1, "one undo step");

        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_eq!(
            snap(&conn),
            before,
            "Undo puts the entry and the state back"
        );
        crate::deck_undo::apply_reversal(&conn, deck, audit, false).unwrap();
        assert_eq!(snap(&conn), after, "and Redo takes them again");
    }

    /// **Every token write settles a stale `hidden`**, as an add always has: the dismissal is a
    /// pre-v55 word nothing draws, and a write to the token is the reader using it. A step on a
    /// Treasure the deck makes sends it to `auto` (no row), a remove on a Soldier nothing makes that
    /// still holds another entry sends it to `manual`, and each rides its write's own undo step.
    #[test]
    fn a_write_to_a_dismissed_token_settles_its_state_with_the_write() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");

        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 2).unwrap();
        assert!(stored(&conn, deck).is_empty(), "`auto`, which is no row");
        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_eq!(
            (entries(&conn, deck), stored(&conn, deck)),
            (
                vec![],
                vec![(
                    treasure().oracle_id.to_owned(),
                    None,
                    None,
                    "hidden".to_owned()
                )]
            ),
            "one Undo puts the count and the word back together"
        );

        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 1);
        seed_entry(&conn, deck, "theory", &soldier(), "nonfoil", 1);
        remove_entry(
            &conn,
            deck,
            "theory",
            soldier().oracle_id,
            &treasure_key(&soldier(), "nonfoil"),
        )
        .unwrap();
        assert_eq!(
            stored(&conn, deck).last().map(|r| r.3.as_str()),
            Some("manual"),
            "the reader's own, still held in the live list"
        );
    }

    // ── The state ────────────────────────────────────────────────────────────────────

    /// **Every word the constant carries is one the DDL's `CHECK` takes**, and a word outside it
    /// is refused by the table — the constant is held to the table rather than to itself. No
    /// command hands this column a word any more (v55 retired `deck_token_state`), so the fence
    /// is the table's, and the constant is how this module names what it writes.
    #[test]
    fn every_state_word_is_one_the_table_accepts() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        for word in TOKEN_STATES {
            write_state(&conn, deck, treasure().oracle_id, word)
                .unwrap_or_else(|e| panic!("`{word}` must be a state the table accepts: {e}"));
        }
        assert!(
            write_state(&conn, deck, treasure().oracle_id, "nonsense").is_err(),
            "and the table refuses a word it does not know"
        );
    }

    /// **`auto` with nothing to carry is not representable** — the write deletes rather than
    /// storing a husk — and `auto` over a row that carries a legacy quantity keeps the quantity.
    #[test]
    fn an_auto_state_with_nothing_to_carry_is_deleted_rather_than_stored() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        write_state(&conn, deck, treasure().oracle_id, "manual").unwrap();
        assert_eq!(stored(&conn, deck).len(), 1);
        write_state(&conn, deck, treasure().oracle_id, "auto").unwrap();
        assert!(
            stored(&conn, deck).is_empty(),
            "back to no row, never a husk"
        );

        seed_state(&conn, deck, treasure().oracle_id, Some(3), "hidden");
        write_state(&conn, deck, treasure().oracle_id, "auto").unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                None,
                Some(3),
                "auto".to_owned()
            )],
            "the legacy quantity is never written again — and never dropped either"
        );
    }

    #[test]
    fn the_state_grain_refuses_a_duplicate_deck_and_oracle() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");
        write_state(&conn, deck, treasure().oracle_id, "manual").unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                None,
                None,
                "manual".to_owned()
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
            "and a write going round the module is refused"
        );
    }

    // ── History and undo ─────────────────────────────────────────────────────────────

    fn audit_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap()
    }

    /// The newest history row of a deck, `(kind, payload)`.
    fn newest_audit(conn: &Connection, deck: i64) -> (String, serde_json::Value) {
        let (kind, payload): (String, String) = conn
            .query_row(
                "SELECT kind, payload FROM deck_audit WHERE deck_id = ?1
                  ORDER BY id DESC LIMIT 1",
                params![deck],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        (kind, serde_json::from_str(&payload).unwrap())
    }

    /// **Every token write is one `deck` history row with `field: "token"` and one undo step** —
    /// never a new audit kind, because `deck_audit` syncs and a paired device on an older build
    /// would refuse the word and stall its stream (Review Focus 3).
    #[test]
    fn every_token_write_is_one_deck_row_and_one_step() {
        type Write = (&'static str, fn(&Connection, i64));
        let writes: [Write; 4] = [
            ("quantity", |c, d| {
                set_quantity(c, d, "live", treasure().oracle_id, None, 3).unwrap();
            }),
            ("swap", |c, d| {
                swap(
                    c,
                    d,
                    "live",
                    treasure().oracle_id,
                    None,
                    &treasure_key(&treasure_older(), "foil"),
                )
                .unwrap();
            }),
            ("add", |c, d| {
                add_printing(c, d, "live", treasure_older().id, Some("foil")).unwrap();
            }),
            ("remove", |c, d| {
                seed_entry(c, d, "live", &treasure(), "nonfoil", 2);
                c.execute("DELETE FROM deck_audit", []).unwrap();
                remove_entry(
                    c,
                    d,
                    "live",
                    treasure().oracle_id,
                    &treasure_key(&treasure(), "nonfoil"),
                )
                .unwrap();
            }),
        ];
        for (action, write) in writes {
            let conn = open();
            let (deck, _, _) = tithe_deck(&conn);
            conn.execute("DELETE FROM deck_audit", []).unwrap();
            write(&conn, deck);

            assert_eq!(audit_rows(&conn), 1, "`{action}` owes exactly one row");
            let (kind, payload) = newest_audit(&conn, deck);
            assert_eq!(
                kind, "deck",
                "`{action}` is a `deck` row and never a new kind"
            );
            assert_eq!(payload["field"], json!("token"));
            assert_eq!(payload["action"], json!(action));
            assert_eq!(payload["name"], json!("Treasure"));
            assert_eq!(
                payload["subtitle"],
                json!("Colorless · {T}, Sacrifice this token: Add one mana of any color."),
                "`deckTokens.ts`' own example, ported term for term"
            );
            let steps: i64 = conn
                .query_row(
                    "SELECT count(*) FROM deck_undo WHERE deck_id = ?1",
                    params![deck],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(steps, 1, "`{action}` files one step");
        }
        assert_eq!(
            crate::schema::AUDIT_KINDS.len(),
            9,
            "and the kinds stay nine — a token row is a `deck` row"
        );
    }

    /// The payload's facts, per action — what `auditText.ts` words.
    #[test]
    fn a_token_history_row_records_the_entry_the_list_and_both_numbers() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);

        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 3).unwrap();
        let (_, quantity) = newest_audit(&conn, deck);
        assert_eq!(
            (
                &quantity["card_id"],
                &quantity["finish"],
                &quantity["list"],
                &quantity["from"],
                &quantity["to"]
            ),
            (
                &json!(treasure().id),
                &json!("nonfoil"),
                &json!("live"),
                &json!(0),
                &json!(3)
            ),
            "from the implicit entry's 0 to 3, on the entry it materialised"
        );

        add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap();
        let (_, add) = newest_audit(&conn, deck);
        assert_eq!(
            (&add["finish"], &add["from"], &add["to"], &add["quantity"]),
            (&json!("foil"), &json!(0), &json!(1), &json!(1)),
            "`quantity` is the copies added, `to` the entry's total"
        );

        remove_entry(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            &treasure_key(&treasure_older(), "foil"),
        )
        .unwrap();
        let (_, remove) = newest_audit(&conn, deck);
        assert_eq!(
            (
                &remove["finish"],
                &remove["set_code"],
                &remove["collector_number"],
                &remove["from"],
                &remove["to"]
            ),
            (
                &json!("foil"),
                &json!("tvow"),
                &json!("17"),
                &json!(1),
                &serde_json::Value::Null
            ),
            "the printing by set and number, and the copies the entry held"
        );
    }

    /// An emblem's history row carries no subtitle — its type line already names the
    /// planeswalker — and a Wurm's carries the line that tells it from the other Wurm.
    #[test]
    fn a_token_history_row_names_it_as_the_wall_does() {
        let conn = open();
        wurm_deathtouch().insert(&conn);
        elspeth_emblem().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        add_printing(&conn, deck, "live", wurm_deathtouch().id, None).unwrap();
        assert_eq!(
            newest_audit(&conn, deck).1["subtitle"],
            json!("Colorless 3/3 · Deathtouch")
        );
        add_printing(&conn, deck, "live", elspeth_emblem().id, None).unwrap();
        assert_eq!(
            newest_audit(&conn, deck).1["subtitle"],
            serde_json::Value::Null
        );
        assert_eq!(
            one_line("Flying\n\nWhen it dies,  draw.\n"),
            "Flying · When it dies,  draw. ·",
            "a run holding a line break folds; one without is kept"
        );
    }

    /// **Undo puts the table back and redo takes it forward again, for each of the four** —
    /// through `deck_undo::apply_reversal`, the command's own path. `deck_undo`'s own sweep
    /// drives the same writes over its fixture; this one reads the two token tables directly,
    /// which that sweep's snapshot only reaches through its `decks`-shaped lens.
    #[test]
    fn every_token_write_undoes_and_redoes_exactly() {
        /// A name, the state the write starts from, and the write.
        type Case = (&'static str, fn(&Connection, i64), fn(&Connection, i64));
        fn two_entries(c: &Connection, d: i64) {
            seed_entry(c, d, "live", &treasure(), "nonfoil", 2);
            seed_entry(c, d, "live", &treasure_older(), "foil", 1);
        }
        fn nothing(_: &Connection, _: i64) {}
        let cases: [Case; 8] = [
            ("quantity (materialising)", nothing, |c, d| {
                set_quantity(c, d, "live", treasure().oracle_id, None, 3).unwrap();
            }),
            ("quantity (one of two to zero)", two_entries, |c, d| {
                set_quantity(
                    c,
                    d,
                    "live",
                    treasure().oracle_id,
                    Some(&treasure_key(&treasure_older(), "foil")),
                    0,
                )
                .unwrap();
            }),
            ("swap (folding)", two_entries, |c, d| {
                swap(
                    c,
                    d,
                    "live",
                    treasure().oracle_id,
                    Some(&treasure_key(&treasure(), "nonfoil")),
                    &treasure_key(&treasure_older(), "foil"),
                )
                .unwrap();
            }),
            ("add (materialising)", nothing, |c, d| {
                add_printing(c, d, "live", treasure_older().id, Some("foil")).unwrap();
            }),
            (
                "add (a token nothing makes, which becomes manual)",
                nothing,
                |c, d| {
                    add_printing(c, d, "live", soldier().id, None).unwrap();
                },
            ),
            ("remove (one of two)", two_entries, |c, d| {
                remove_entry(
                    c,
                    d,
                    "live",
                    treasure().oracle_id,
                    &treasure_key(&treasure_older(), "foil"),
                )
                .unwrap();
            }),
            (
                "remove (a derived token's last entry, back to its implicit one)",
                |c, d| seed_entry(c, d, "live", &treasure_older(), "foil", 2),
                |c, d| {
                    remove_entry(
                        c,
                        d,
                        "live",
                        treasure().oracle_id,
                        &treasure_key(&treasure_older(), "foil"),
                    )
                    .unwrap();
                },
            ),
            (
                "remove (a hand-added token's last entry anywhere, which takes its state)",
                |c, d| {
                    add_printing(c, d, "live", soldier().id, None).unwrap();
                },
                |c, d| {
                    remove_entry(
                        c,
                        d,
                        "live",
                        soldier().oracle_id,
                        &treasure_key(&soldier(), "nonfoil"),
                    )
                    .unwrap();
                },
            ),
        ];
        for (name, setup, write) in cases {
            let conn = open();
            let (deck, _, _) = tithe_deck(&conn);
            soldier().insert(&conn);
            setup(&conn, deck);
            let snap = |c: &Connection| (entries(c, deck), stored(c, deck));
            let before = snap(&conn);

            write(&conn, deck);
            let after = snap(&conn);
            assert_ne!(after, before, "`{name}` must change something");
            let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();

            crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
            assert_eq!(snap(&conn), before, "`{name}` must undo exactly");
            crate::deck_undo::apply_reversal(&conn, deck, audit, false).unwrap();
            assert_eq!(snap(&conn), after, "`{name}` must redo exactly");
        }
    }

    /// **An undo after a write that filed no step moved the entries is retired**, never applied
    /// over them — `deck_undo::tokens_hold` checking the side the reversal leaves.
    #[test]
    fn undoing_a_token_write_the_deck_has_moved_past_is_retired() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 3).unwrap();
        // A sync pull, say: the entry moved with no step.
        conn.execute(
            "UPDATE deck_token_printings SET quantity = 5 WHERE deck_id = ?1",
            params![deck],
        )
        .unwrap();

        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        assert_eq!(
            crate::deck_undo::apply_reversal(&conn, deck, audit, true),
            Err(crate::deck_undo::RETIRED.to_owned())
        );
        assert_eq!(
            entries(&conn, deck)[0].4,
            5,
            "and nothing was written over it"
        );
    }

    // ── Rule 7: the reconcile ────────────────────────────────────────────────────────

    #[test]
    fn a_reconcile_removes_a_token_nothing_makes_and_keeps_a_manual_one() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 0);
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 0);
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 3);
        seed_state(&conn, deck, soldier().oracle_id, None, "manual");

        assert!(
            reconcile_in(&conn, deck, &["live"]).unwrap().is_empty(),
            "the Tithe still makes the Treasure, and the Soldier is the reader's"
        );

        conn.execute("DELETE FROM deck_cards WHERE deck_id = ?1", params![deck])
            .unwrap();
        let done = reconcile_in(&conn, deck, &["live"]).unwrap();
        assert_eq!(
            done.removed
                .iter()
                .map(|r| (r.card_id.as_str(), r.finish.as_str(), r.quantity))
                .collect::<Vec<_>>(),
            vec![
                (treasure_older().id, "foil", 0),
                (treasure().id, "nonfoil", 0)
            ],
            "the rows it removed, for the caller's step"
        );
        assert!(
            done.states_before.is_empty(),
            "a token held at nothing is not one the reader is using, so nothing is kept"
        );
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", soldier().oracle_id, soldier().id, "nonfoil", 3)],
            "the manual token stays — no card made it, so no cut can unmake it"
        );
    }

    /// **Issue #671: a token the reader has copies of outlives the card that made it.** Cutting
    /// the maker deletes the Treasure's entry at zero and keeps the one with copies, and the token
    /// becomes `manual` — so the wall draws it as not made by the deck (`derived: false`, the red
    /// outline), and the reader can see what to take out of the physical deck. The states ride the
    /// answer for the caller's step.
    #[test]
    fn a_reconcile_keeps_a_token_with_copies_as_the_readers_own() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        seed_used_and_zero_treasure(&conn, deck);

        conn.execute("DELETE FROM deck_cards WHERE deck_id = ?1", params![deck])
            .unwrap();
        let done = reconcile_in(&conn, deck, &["live"]).unwrap();
        assert_eq!(
            done.removed,
            vec![TokenEntryRow {
                variant: "live".to_owned(),
                oracle_id: treasure().oracle_id.to_owned(),
                card_id: treasure_older().id.to_owned(),
                finish: "foil".to_owned(),
                quantity: 0,
            }],
            "only the entry at zero goes"
        );
        assert_eq!(
            done.states_before
                .iter()
                .map(|s| (s.oracle_id.as_str(), s.state.as_deref()))
                .collect::<Vec<_>>(),
            vec![(treasure().oracle_id, None)],
            "the Treasure was the deck's"
        );
        assert_eq!(
            done.states_after
                .iter()
                .map(|s| (s.oracle_id.as_str(), s.state.as_deref()))
                .collect::<Vec<_>>(),
            vec![(treasure().oracle_id, Some(MANUAL_STATE))],
            "and is the reader's now"
        );
        assert_kept_as_manual(&conn, deck, "reconcile_in");

        let drawn = rows(&conn, deck);
        assert_eq!(drawn.len(), 1, "one tile, the entry with copies");
        assert!(!drawn[0].derived, "drawn as not made by the deck");
        assert!(drawn[0].sources.is_empty());
        assert_eq!(
            (drawn[0].card_id.as_str(), drawn[0].quantity),
            (treasure().id, 2)
        );

        assert!(
            reconcile_in(&conn, deck, &["live"]).unwrap().is_empty(),
            "and a later reconcile leaves the reader's token alone"
        );

        play(&conn, deck, main, &tithe(), "live");
        let drawn = rows(&conn, deck);
        assert!(
            drawn.iter().all(|r| r.derived),
            "the maker back makes it the deck's again, outline gone"
        );
        assert_eq!(drawn[0].quantity, 2, "with the reader's copies");
    }

    /// **The zero entries of a kept token go in every list the pass walks** — the state flip
    /// waits until every list is settled, so a Treasure kept in the live list does not shield its
    /// zero entry in a plan that makes it no more either.
    #[test]
    fn a_kept_token_still_loses_its_zero_entries_in_the_other_list() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "theory", &treasure(), "nonfoil", 0);

        conn.execute("DELETE FROM deck_cards WHERE deck_id = ?1", params![deck])
            .unwrap();
        let done = reconcile_in(&conn, deck, &["live", "theory"]).unwrap();
        assert_eq!(done.removed.len(), 1);
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 2)]
        );
        assert_eq!(
            state_word(&conn, deck, treasure().oracle_id).as_deref(),
            Some(MANUAL_STATE)
        );
    }

    /// **A dismissed token nothing makes keeps its entries through a card write's reconcile**
    /// (the final review's M1). A `hidden` row with entries in a list that derives nothing is drawn
    /// like `manual` — `deck_token_rows`' hand-added tail reads any state but `auto` — and until the
    /// next launch's [`retire_hidden`] settles it, it is the reader's as much as a `manual` one is.
    /// A reconcile that took it would delete what the wall is drawing, capture the deletes for the
    /// group, and — from the backstop — file them on no undo step. Only `auto` is the deck's to
    /// take.
    #[test]
    fn a_reconcile_keeps_a_dismissed_token_nothing_makes() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 3);
        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");

        // The card write: the Tithe cut through a write that files a step, so its own
        // transaction runs the reconcile.
        crate::deck::set_card_quantity(&conn, deck, tithe().id, main, "live", None, 0).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 2),
                e("live", soldier().oracle_id, soldier().id, "nonfoil", 3)
            ],
            "the Treasure the Tithe made is kept by hand (issue #671); the dismissed Soldier nothing makes is untouched"
        );
        assert_eq!(
            state_word(&conn, deck, soldier().oracle_id).as_deref(),
            Some(HIDDEN_STATE),
            "the dismissal is not rewritten — that is `retire_hidden`'s, at the next launch"
        );
        assert!(
            reconcile_in(&conn, deck, &["live"]).unwrap().is_empty(),
            "nor does a later reconcile take it"
        );
    }

    /// **A list whose makers cannot all be read deletes nothing.** A device paired before its
    /// first corpus download derives nothing from anything, and a reconcile there — its deletions
    /// captured and pushed — would wipe the reader's token printings on every device.
    #[test]
    fn a_reconcile_over_a_list_it_cannot_read_deletes_nothing() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        let gone = Card {
            id: "c-left-the-corpus",
            ..Card::default()
        };
        play(&conn, deck, main, &gone, "live");
        conn.execute(
            "DELETE FROM deck_cards WHERE card_id = ?1",
            params![tithe().id],
        )
        .unwrap();

        assert!(reconcile_in(&conn, deck, &["live"]).unwrap().is_empty());
        assert_eq!(entries(&conn, deck).len(), 1);
    }

    /// The reconcile only looks at the lists it is asked about (rule 6).
    #[test]
    fn a_reconcile_touches_only_the_lists_it_is_asked_about() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "theory", &treasure(), "nonfoil", 2);
        assert!(
            reconcile_in(&conn, deck, &["live"]).unwrap().is_empty(),
            "the live list makes the Treasure"
        );
        assert_eq!(
            reconcile_in(&conn, deck, &["theory"])
                .unwrap()
                .states_after
                .len(),
            1,
            "the theory list makes nothing, so its Treasure with copies is kept by hand"
        );
    }

    /// **The in-transaction hook, through the card write that files a step** — cutting the
    /// maker through `set_card_quantity(.., 0)` takes the Treasure's entry at zero and keeps the
    /// one with copies as `manual` (issue #671), and the history holds no second row for it: both
    /// ride the cut's own step (Review Focus 2's first half; `deck_undo`'s sweep undoes it).
    #[test]
    fn cutting_the_maker_settles_its_tokens_entries_inside_the_cut() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        seed_used_and_zero_treasure(&conn, deck);

        crate::deck::set_card_quantity(&conn, deck, tithe().id, main, "live", None, 0).unwrap();
        assert_kept_as_manual(&conn, deck, "the cut");

        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_restored_as_auto(&conn, deck, "the cut");
        assert!(
            rows(&conn, deck).iter().all(|r| r.derived),
            "with the card that makes them"
        );

        let redo = crate::deck_undo::next_redo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, redo, false).unwrap();
        assert_kept_as_manual(&conn, deck, "the redo");
    }

    /// **The whole-list hook** — `deck_undo::record_variant`'s: an import that replaces the list
    /// with one that no longer plays the maker settles the Treasure in the import's own
    /// transaction, and the import's one Ctrl+Z brings it back with the list.
    #[test]
    fn an_import_replacing_the_maker_removes_the_entries_and_undo_restores_them() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        // Krenko and his Goblin both, so the new list's makers all read — a reconcile over a
        // list it cannot read deletes nothing.
        krenko().insert(&conn);
        goblin().insert(&conn);
        seed_used_and_zero_treasure(&conn, deck);

        crate::import::commit_import(
            &conn,
            deck,
            "live",
            "replace",
            &[crate::import::ImportItem {
                card_id: krenko().id.to_owned(),
                quantity: 1,
                category_name: "Main deck".to_owned(),
                inactive: false,
                finish: None,
                label_name: None,
                label_color: None,
            }],
        )
        .unwrap();
        assert_kept_as_manual(&conn, deck, "the import");

        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_restored_as_auto(&conn, deck, "the import");
    }

    /// The same through the two hand-built steps in `deck_meta`: switching the maker's pile off,
    /// and deleting it.
    #[test]
    fn switching_the_makers_pile_off_or_deleting_it_removes_the_entries_and_undo_restores_them() {
        for delete in [false, true] {
            let conn = open();
            let (deck, main, _) = tithe_deck(&conn);
            conn.execute(
                "UPDATE deck_categories SET kind = 'main' WHERE id = ?1",
                params![main],
            )
            .unwrap();
            seed_used_and_zero_treasure(&conn, deck);

            if delete {
                crate::deck_meta::delete_category(&conn, main, None).unwrap();
            } else {
                crate::deck_meta::set_category_active(&conn, main, false).unwrap();
            }
            assert_kept_as_manual(&conn, deck, &format!("delete: {delete}"));

            let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
            crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
            assert_restored_as_auto(&conn, deck, &format!("delete: {delete}"));
        }
    }

    // ── The launch repair ────────────────────────────────────────────────────────────

    /// **An entry `nonfoil` on a foil-only printing becomes `foil`**, a correct entry is left
    /// alone, a repair landing on an entry the list holds folds, and a second run changes
    /// nothing.
    #[test]
    fn the_finish_repair_moves_an_unsold_finish_to_the_sole_one_and_is_idempotent() {
        let conn = open();
        let foil_only = Card {
            id: "c-treasure-foil-only",
            finishes: r#"["foil"]"#,
            ..treasure()
        };
        foil_only.insert(&conn);
        treasure_older().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        seed_entry(&conn, deck, "live", &foil_only, "nonfoil", 2);
        seed_entry(&conn, deck, "theory", &foil_only, "nonfoil", 1);
        seed_entry(&conn, deck, "theory", &foil_only, "foil", 4);
        seed_entry(&conn, deck, "live", &treasure_older(), "nonfoil", 3);

        repair_entry_finishes(&conn).unwrap();
        let once = entries(&conn, deck);
        assert_eq!(
            once,
            vec![
                e("live", treasure().oracle_id, foil_only.id, "foil", 2),
                e(
                    "live",
                    treasure().oracle_id,
                    treasure_older().id,
                    "nonfoil",
                    3
                ),
                e("theory", treasure().oracle_id, foil_only.id, "foil", 5),
            ],
            "moved, left alone, and folded"
        );
        repair_entry_finishes(&conn).unwrap();
        assert_eq!(
            entries(&conn, deck),
            once,
            "a second launch changes nothing"
        );
    }

    /// **The repair keeps the entry's `sync_uid`, on a device where capture is live.**
    ///
    /// The repair runs behind `capture::suppressed`, and the insert trigger's uid mint sits inside
    /// the same guard — so a repair written as delete-then-insert brings the row back **with no
    /// name**, and the next captured write to it (a stepper, whose update trigger has no uid
    /// guard) puts a NULL into `sync_ops.uid NOT NULL` and fails for good. The fixture is paired
    /// (a `sync_group` row) with the capture triggers installed, which is the only fixture that
    /// can see it: an unpaired file mints uids the same way and records nothing to fail on.
    #[test]
    fn the_finish_repair_keeps_the_entrys_uid_and_a_later_step_is_captured() {
        let conn = paired();
        let foil_only = Card {
            id: "c-treasure-foil-only",
            finishes: r#"["foil"]"#,
            ..treasure()
        };
        foil_only.insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        seed_entry(&conn, deck, "live", &foil_only, "nonfoil", 2);
        let uid_of = |c: &Connection| -> Option<String> {
            c.query_row(
                "SELECT sync_uid FROM deck_token_printings WHERE deck_id = ?1",
                params![deck],
                |r| r.get(0),
            )
            .unwrap()
        };
        let named = uid_of(&conn).expect("a captured insert names the row");

        repair_entry_finishes(&conn).unwrap();
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", treasure().oracle_id, foil_only.id, "foil", 2)],
            "the finish moved"
        );
        assert_eq!(
            uid_of(&conn),
            Some(named.clone()),
            "and the row kept its name"
        );

        conn.execute("DELETE FROM sync_ops", []).unwrap();
        set_quantity(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            Some(&treasure_key(&foil_only, "foil")),
            3,
        )
        .expect("a step on a repaired entry must still be capturable");
        let op_uids: Vec<String> = conn
            .prepare("SELECT uid FROM sync_ops WHERE tbl = 'deck_token_printings'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            op_uids,
            vec![named],
            "the step's op names the entry it moved"
        );
    }

    /// Everything a device has recorded since the last call, oldest first — what its next push
    /// would carry.
    fn since(conn: &Connection, mark: &mut i64) -> Vec<crate::sync_engine::merge::Op> {
        let sql = format!(
            "{} WHERE seq > ?1 ORDER BY seq",
            crate::sync_engine::capture::OPS_SELECT
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(i64, crate::sync_engine::merge::Op)> = stmt
            .query_map([*mark], crate::sync_engine::capture::op_from_row)
            .unwrap()
            .map(Result::unwrap)
            .collect();
        if let Some((seq, _)) = rows.last() {
            *mark = *seq;
        }
        rows.into_iter().map(|(_, op)| op).collect()
    }

    /// **A token dismissed before this build comes back at zero, its printings kept** (spec
    /// §3.3). A dismissed Treasure the deck still makes has entries at 2 in the live list and 1
    /// in the plan; both go to zero at the printings they name, and the token is `auto` again,
    /// which is no row. A dismissed Soldier nothing makes becomes the reader's own. **On a paired
    /// device, and no op is recorded**: every device retires the same synced rows alike, so there
    /// is nothing to announce. And a second launch changes nothing — which is also what retires a
    /// `hidden` an older peer sends after the first (Review Focus 1).
    #[test]
    fn retire_hidden_zeroes_a_dismissed_tokens_entries_and_keeps_them() {
        let conn = paired();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        soldier().insert(&conn);
        seed_entry(&conn, deck, "live", &treasure_older(), "foil", 2);
        seed_entry(&conn, deck, "theory", &treasure(), "nonfoil", 1);
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 3);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");
        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        retire_hidden(&conn).unwrap();

        let once = (entries(&conn, deck), stored(&conn, deck));
        assert_eq!(
            once.0,
            vec![
                e("live", treasure().oracle_id, treasure_older().id, "foil", 0),
                e("live", soldier().oracle_id, soldier().id, "nonfoil", 0),
                e("theory", treasure().oracle_id, treasure().id, "nonfoil", 0),
            ],
            "every entry at zero, in both lists, at the printing it named"
        );
        assert_eq!(
            once.1,
            vec![(
                soldier().oracle_id.to_owned(),
                None,
                None,
                "manual".to_owned()
            )],
            "the Treasure the deck still makes is `auto` again, which is no row; the Soldier \
             nothing makes is the reader's own"
        );
        assert_eq!(ops(&conn), 0, "and nothing was announced");
        let live = rows(&conn, deck);
        assert_eq!(names(&live), vec!["Treasure", "Soldier"]);
        assert!(live.iter().all(|r| r.state != "hidden" && r.quantity == 0));

        retire_hidden(&conn).unwrap();
        assert_eq!(
            (entries(&conn, deck), stored(&conn, deck)),
            once,
            "a second launch changes nothing"
        );
        assert_eq!(ops(&conn), 0);
    }

    /// **A dismissal the pass cannot prove unmade is left for a later launch** —
    /// [`Derivation::unreadable`]'s rule, one pass over. A list with a maker this corpus cannot
    /// read might still make the Soldier, and `manual` would keep it from every reconcile after
    /// its maker was cut. The Treasure is proved made by a maker that *can* be read, so it is
    /// retired all the same.
    #[test]
    fn retire_hidden_leaves_a_token_it_cannot_prove_unmade() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        let gone = Card {
            id: "c-left-the-corpus",
            ..Card::default()
        };
        play(&conn, deck, main, &gone, "live");
        soldier().insert(&conn);
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 1);
        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");

        retire_hidden(&conn).unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                soldier().oracle_id.to_owned(),
                None,
                None,
                "hidden".to_owned()
            )],
            "the Soldier waits; the Treasure is `auto` again"
        );
        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 0),
                e("live", soldier().oracle_id, soldier().id, "nonfoil", 2),
            ],
            "and the waiting token keeps its count until it is retired whole"
        );
    }

    /// **A dismissed token whose only count is the legacy column comes back at zero too** — the
    /// reader's rule is *at zero*, and `write_state` alone keeps a legacy quantity. The row
    /// carried nothing but that count and the dismissal, so once both are gone it is no row, and
    /// each list draws the implicit entry at zero.
    #[test]
    fn retire_hidden_brings_a_legacy_count_back_at_zero() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        seed_state(&conn, deck, treasure().oracle_id, Some(3), "hidden");

        retire_hidden(&conn).unwrap();

        assert!(
            stored(&conn, deck).is_empty(),
            "no dismissal and no count left to carry, so no row: {:?}",
            stored(&conn, deck)
        );
        for variant in crate::schema::DECK_VARIANTS {
            let out = deck_token_rows(&conn, deck, variant, Marketplace::Tcgplayer).unwrap();
            assert_eq!(
                (out.len(), out[0].implicit, out[0].quantity),
                (1, true, 0),
                "the {variant} list draws the implicit Treasure at zero"
            );
        }
    }

    /// **A dismissal settled by a write comes back at zero in the other list too** (the final
    /// review's deferred 1). A step on the live list settles the stale `hidden` there and then —
    /// and until then [`write_state`] kept the legacy count, so the plan's implicit Treasure came
    /// back at the old 3 while [`retire_hidden`] would have brought it back at 0. The count is
    /// cleared with the word, inside the write's own step, so one Undo puts both back.
    #[test]
    fn a_write_that_settles_a_dismissal_clears_its_legacy_count() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        seed_state(&conn, deck, treasure().oracle_id, Some(3), "hidden");

        set_quantity(&conn, deck, "live", treasure().oracle_id, None, 2).unwrap();

        let plan = deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            (plan.len(), plan[0].implicit, plan[0].quantity),
            (1, true, 0),
            "the plan's implicit Treasure at zero, not at the dismissal's old 3"
        );
        assert!(
            stored(&conn, deck).is_empty(),
            "no dismissal and no count left to carry, so no row: {:?}",
            stored(&conn, deck)
        );

        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                None,
                Some(3),
                "hidden".to_owned()
            )],
            "one Undo brings the word and the count back together"
        );
    }

    /// **And an added printing clears it before the implicit entry is written**, so the Treasure
    /// the dismissal left at 3 is not materialised at 3 beside the new printing: the add files the
    /// new printing alone, and the plan's implicit Treasure reads zero.
    #[test]
    fn an_add_that_settles_a_dismissal_clears_its_legacy_count_first() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        seed_state(&conn, deck, treasure().oracle_id, Some(3), "hidden");

        add_printing(&conn, deck, "live", treasure_older().id, Some("foil")).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "live",
                treasure().oracle_id,
                treasure_older().id,
                "foil",
                1
            )],
            "the new printing alone — no implicit Treasure materialised at the old count"
        );
        let plan = deck_token_rows(&conn, deck, "theory", Marketplace::Tcgplayer).unwrap();
        assert_eq!((plan[0].implicit, plan[0].quantity), (true, 0));
        assert!(stored(&conn, deck).is_empty(), "{:?}", stored(&conn, deck));
    }

    /// **The launch settles the managed wishlist after it retires the dismissals** (the final
    /// review's M2). `prepare_database` ran `managed_wishlist::settle_all` ahead of the retire
    /// pass, so on the first v55 launch a theory deck following `tokens` filed a wish for the
    /// Treasure its plan counted at 3 — a count the pass then zeroed, with nothing left to settle
    /// the folder again until the reader's first write. The launch drains the marks the passes
    /// left, so the plan is short of nothing and the folder holds nothing.
    #[test]
    fn the_launch_files_no_managed_token_wish_for_a_dismissal_it_retires() {
        let conn = open();
        let (deck, main, _) = tithe_deck(&conn);
        conn.execute(
            "UPDATE decks SET theory_enabled = 1, managed_wishlist_mode = 'tokens' WHERE id = ?1",
            params![deck],
        )
        .unwrap();
        play(&conn, deck, main, &tithe(), "theory");
        seed_entry(&conn, deck, "theory", &treasure(), "nonfoil", 3);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");

        crate::schema::prepare_database(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![e(
                "theory",
                treasure().oracle_id,
                treasure().id,
                "nonfoil",
                0
            )],
            "the pass retired the dismissal at zero"
        );
        let wishes: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            wishes, 0,
            "and the managed wishlist was settled after it, so it wants no Treasure"
        );
    }

    /// **A dismissed pick a paired device has not converted yet comes back at zero as well.** On a
    /// device climbing from v51 the launch converts nothing until a pull lands
    /// ([`convert_legacy_picks_at_launch`]'s gate), so this pass runs first and the pull's
    /// conversion after it — which files each pick at `quantity ?? 1`. The pass zeroes the pick's
    /// count so the entries it becomes are at zero: the Treasure's count of 3 and the Soldier's
    /// absent one alike. The Soldier nothing makes stays the reader's own, because the pick it
    /// holds becomes its entries.
    #[test]
    fn retire_hidden_zeroes_a_pick_the_pull_has_not_converted_yet() {
        let conn = paired();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_pick(&conn, deck, &treasure_older(), Some(3), "u-treasure");
        seed_pick(&conn, deck, &soldier(), None, "u-soldier");
        conn.execute(
            "UPDATE deck_tokens SET state = 'hidden' WHERE deck_id = ?1",
            params![deck],
        )
        .unwrap();

        convert_legacy_picks_at_launch(&conn).unwrap();
        assert!(entries(&conn, deck).is_empty(), "the gate holds the picks");
        retire_hidden(&conn).unwrap();
        convert_legacy_picks_after_pull(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e(
                    "live",
                    treasure().oracle_id,
                    treasure_older().id,
                    "nonfoil",
                    0
                ),
                e("live", soldier().oracle_id, soldier().id, "nonfoil", 0),
                e(
                    "theory",
                    treasure().oracle_id,
                    treasure_older().id,
                    "nonfoil",
                    0
                ),
                e("theory", soldier().oracle_id, soldier().id, "nonfoil", 0),
            ],
            "every entry the pull converts is at zero, the printings kept"
        );
        let states: Vec<String> = stored(&conn, deck).into_iter().map(|r| r.3).collect();
        assert_eq!(states, ["auto", "manual"]);
    }

    /// **A dismissed token nothing makes and nothing holds goes back to `auto`**, which is no row
    /// — `manual` there would be a row drawn in no list.
    #[test]
    fn retire_hidden_sends_a_token_nothing_makes_or_holds_to_auto() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");

        retire_hidden(&conn).unwrap();
        assert!(stored(&conn, deck).is_empty(), "{:?}", stored(&conn, deck));
    }

    /// **One dismissal that cannot be retired costs that token alone** — each is retired inside a
    /// savepoint of its own, [`convert_legacy_picks`]' shape, and a failure is logged and skipped:
    /// one transaction over every deck would retire nothing, at every launch, for as long as the
    /// one kept failing. The next launch retires it.
    #[test]
    fn a_dismissal_that_fails_to_retire_is_skipped_and_every_other_is_retired() {
        let conn = open();
        let (deck, _, _) = tithe_deck(&conn);
        soldier().insert(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &soldier(), "nonfoil", 3);
        seed_state(&conn, deck, treasure().oracle_id, None, "hidden");
        seed_state(&conn, deck, soldier().oracle_id, None, "hidden");
        conn.execute_batch(&format!(
            "CREATE TEMP TRIGGER refuse_treasure BEFORE UPDATE ON deck_token_printings
               WHEN OLD.oracle_id = '{}'
             BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            treasure().oracle_id
        ))
        .unwrap();

        retire_hidden(&conn).expect("a token that fails is skipped, not the pass");
        assert_eq!(
            stored(&conn, deck),
            vec![
                (
                    treasure().oracle_id.to_owned(),
                    None,
                    None,
                    "hidden".to_owned()
                ),
                (
                    soldier().oracle_id.to_owned(),
                    None,
                    None,
                    "manual".to_owned()
                ),
            ],
            "the Treasure waits and the Soldier is retired"
        );
        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 2),
                e("live", soldier().oracle_id, soldier().id, "nonfoil", 0),
            ],
            "and the Treasure's count is untouched, not half-written"
        );

        conn.execute_batch("DROP TRIGGER temp.refuse_treasure")
            .unwrap();
        retire_hidden(&conn).unwrap();
        assert_eq!(entries(&conn, deck)[0].4, 0, "the next launch retires it");
    }

    /// Every op this device has recorded, `(table, uid, kind, fields)`, oldest first.
    fn recorded(conn: &Connection) -> Vec<(String, String, String, Value)> {
        conn.prepare("SELECT tbl, uid, kind, fields FROM sync_ops ORDER BY seq")
            .unwrap()
            .query_map([], |r| {
                let fields: String = r.get(3)?;
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    serde_json::from_str(&fields).unwrap_or(Value::Null),
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// Every entry of every deck with its name, `(variant, card, finish, quantity, uid)` — the
    /// shape two devices are compared in.
    fn named_entries(conn: &Connection) -> Vec<(String, String, String, i64, String)> {
        conn.prepare(
            "SELECT variant, card_id, finish, quantity, sync_uid FROM deck_token_printings
              ORDER BY variant, card_id, finish",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// **The conversion announces every entry it derives, and the cleared pick behind them.**
    /// Each entry is a captured insert named `<pick uid>-<list>`, so a peer that never derived it
    /// — a device that had not yet seen the pick when it converted — receives the whole row
    /// rather than a later sparse edit it has no row for. The pick's clear is captured too, and
    /// it is recorded **after** the entries: a v51 peer defers this device's first op for a table
    /// it does not know and leaves the later ones in that page unapplied, so it never applies the
    /// clear ahead of the entry. (A v51 client then drops both, upgrade or not; a v52 or later
    /// one holds them until it upgrades — `sync.md`, *Held while it can resolve, skipped when it
    /// cannot*.)
    #[test]
    fn the_conversion_announces_every_entry_it_derives_and_the_cleared_pick_behind_them() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(3), "u-pick");
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        convert_legacy_picks(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 3),
                e("theory", treasure().oracle_id, treasure().id, "nonfoil", 3),
            ],
            "one entry per list at the pick's count, `nonfoil` until the finish repair"
        );
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                None,
                None,
                "auto".to_owned()
            )],
            "the pick is legacy afterwards and keeps its state"
        );

        let ops = recorded(&conn);
        let named: Vec<(&str, &str, &str)> = ops
            .iter()
            .map(|(t, u, k, _)| (t.as_str(), u.as_str(), k.as_str()))
            .collect();
        assert_eq!(
            named,
            [
                ("deck_token_printings", "u-pick-live", "put"),
                ("deck_token_printings", "u-pick-theory", "put"),
                ("deck_tokens", "u-pick", "put"),
            ],
            "two announced entries under the derived names, then the cleared pick"
        );
        for (_, uid, _, fields) in &ops[..2] {
            assert_eq!(
                (
                    &fields["card_id"],
                    &fields["finish"],
                    &fields["quantity"],
                    &fields["oracle_id"]
                ),
                (
                    &json!(treasure().id),
                    &json!("nonfoil"),
                    &json!(3),
                    &json!(treasure().oracle_id)
                ),
                "{uid} carries the whole row, so a peer can build it"
            );
        }
        assert_eq!(
            (ops[2].3.get("card_id"), ops[2].3.get("quantity")),
            (Some(&Value::Null), Some(&Value::Null)),
            "the clear sends both legacy columns as nulls"
        );
    }

    /// **A second conversion writes nothing and announces nothing** — it runs at every launch, so
    /// idempotence is what keeps a launch from sending a put per entry for ever.
    #[test]
    fn a_second_conversion_writes_nothing_and_announces_nothing() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(3), "u-pick");
        convert_legacy_picks(&conn).unwrap();
        let (once, kept) = (entries(&conn, deck), stored(&conn, deck));
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        convert_legacy_picks(&conn).unwrap();

        assert_eq!(entries(&conn, deck), once);
        assert_eq!(stored(&conn, deck), kept);
        assert_eq!(recorded(&conn), [], "nothing recorded on the second launch");
    }

    /// **A pick that arrives after the conversion is converted by the next pass — behind the pull
    /// that brought it — moving the entry it already named.** A v51 peer that picks a second art
    /// sends `deck_tokens.card_id`, which `apply` writes behind `suppressed`; the entry
    /// `<uid>-live` already exists here, at the old art. The next conversion rewrites that entry's
    /// printing in place — same row, same name, the new printing's default finish — and the
    /// rewrite is captured, so every peer
    /// that holds the entry under that name moves it too.
    #[test]
    fn a_pick_that_arrives_after_the_conversion_moves_the_entry_it_named() {
        let conn = paired();
        treasure_older().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(3), "u-pick");
        convert_legacy_picks(&conn).unwrap();

        crate::sync_engine::capture::suppressed(&conn, || {
            conn.execute(
                "UPDATE deck_tokens SET card_id = ?1 WHERE sync_uid = 'u-pick'",
                [treasure_older().id],
            )
        })
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        convert_legacy_picks(&conn).unwrap();

        assert_eq!(
            named_entries(&conn),
            vec![
                (
                    "live".to_owned(),
                    treasure_older().id.to_owned(),
                    "nonfoil".to_owned(),
                    3,
                    "u-pick-live".to_owned()
                ),
                (
                    "theory".to_owned(),
                    treasure_older().id.to_owned(),
                    "nonfoil".to_owned(),
                    3,
                    "u-pick-theory".to_owned()
                ),
            ],
            "the named entries moved to the new art, keeping their count and their names"
        );
        let ops = recorded(&conn);
        let moved: Vec<(&str, &Value)> = ops
            .iter()
            .filter(|(t, ..)| t == "deck_token_printings")
            .map(|(_, u, _, f)| (u.as_str(), &f["card_id"]))
            .collect();
        assert_eq!(
            moved,
            [
                ("u-pick-live", &json!(treasure_older().id)),
                ("u-pick-theory", &json!(treasure_older().id)),
            ],
            "the move is captured under the names every peer holds"
        );
        assert_eq!(
            stored(&conn, deck)[0].1,
            None,
            "and the pick is cleared again"
        );
    }

    /// **A list that already holds the pick's printing, in any finish, keeps what it holds.** The
    /// finish repair may have moved a converted entry to `foil`, and a reader on v52 may have
    /// added the printing themselves; either way a second entry at `nonfoil` would be a second
    /// row for one art. The other list, which holds nothing, gets its entry.
    #[test]
    fn a_list_already_holding_the_picked_printing_in_any_finish_keeps_it() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "foil", 2);
        seed_pick(&conn, deck, &treasure(), Some(3), "u-pick");

        convert_legacy_picks(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "foil", 2),
                e("theory", treasure().oracle_id, treasure().id, "nonfoil", 3),
            ]
        );
        assert_eq!(stored(&conn, deck)[0].1, None);
    }

    /// **A foil-only pick converts straight to a foil entry, announced as foil, and the finish
    /// repair then has nothing to do.** The conversion runs at launch after `migrate_corpus`, so
    /// it reads the printing's own finishes and files the resolver's `default_finish` — the same
    /// function an implicit entry is drawn in. Every device whose corpus holds the printing
    /// therefore announces identical content, and a repair that would have to move the entry
    /// after an announcement carrying `nonfoil` — the one write that let a later peer put write
    /// the guess back, or a second name land beside the first — never happens for a conversion.
    #[test]
    fn a_foil_only_pick_converts_straight_to_foil_and_the_repair_then_changes_nothing() {
        let conn = paired();
        let foil_only = Card {
            id: "c-treasure-foil-only",
            finishes: r#"["foil"]"#,
            ..treasure()
        };
        foil_only.insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &foil_only, Some(2), "u-pick");
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        convert_legacy_picks(&conn).unwrap();

        let converted = entries(&conn, deck);
        assert_eq!(
            converted,
            vec![
                e("live", treasure().oracle_id, foil_only.id, "foil", 2),
                e("theory", treasure().oracle_id, foil_only.id, "foil", 2),
            ],
            "the printing's own finish, not a guess"
        );
        let announced: Vec<(String, Value)> = recorded(&conn)
            .into_iter()
            .filter(|(t, ..)| t == "deck_token_printings")
            .map(|(_, uid, _, fields)| (uid, fields["finish"].clone()))
            .collect();
        assert_eq!(
            announced,
            [
                ("u-pick-live".to_owned(), json!("foil")),
                ("u-pick-theory".to_owned(), json!("foil")),
            ],
            "the announced insert carries the finish every peer will hold"
        );

        conn.execute("DELETE FROM sync_ops", []).unwrap();
        repair_entry_finishes(&conn).unwrap();
        assert_eq!(
            entries(&conn, deck),
            converted,
            "the repair has nothing to move"
        );
        assert_eq!(recorded(&conn), [], "and writes nothing");
    }

    /// **A pick whose printing this device's corpus does not hold still converts, at `nonfoil`**
    /// — `default_finish`'s own answer when the finishes cannot be read — and the finish repair,
    /// which reads the same corpus, leaves it alone until a sync brings the printing. That is the
    /// case the repair stays for.
    #[test]
    fn a_pick_whose_printing_the_corpus_lacks_converts_at_nonfoil() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        let absent = Card {
            id: "c-not-in-this-corpus",
            ..treasure()
        };
        seed_pick(&conn, deck, &absent, Some(1), "u-pick");

        convert_legacy_picks(&conn).unwrap();
        repair_entry_finishes(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, absent.id, "nonfoil", 1),
                e("theory", treasure().oracle_id, absent.id, "nonfoil", 1),
            ]
        );
    }

    /// What a pull left unwritten: `(deferred, dropped)`. **Both**, because a row the peer
    /// cannot build — the sparse step these tests are about, landing on no row — is skipped as
    /// `dropped` rather than held, and a check on `deferred` alone passes over it.
    fn unwritten(report: crate::sync_engine::apply::ApplyReport) -> (usize, usize) {
        (report.deferred, report.dropped)
    }

    /// Every entry's name and count on one device, `(uid, quantity)`, in name order.
    fn counts(conn: &Connection) -> Vec<(String, i64)> {
        conn.prepare("SELECT sync_uid, quantity FROM deck_token_printings ORDER BY sync_uid")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// **Two devices, a pick made on the v51 one after the other climbed, and no op left
    /// deferred** — the stall the rung-time conversion had. The rung converted only what a device
    /// held when it climbed, behind `suppressed`: a pick arriving afterwards was converted by the
    /// *picker* when it climbed, under a name the first device had never heard, and the picker's
    /// next count step reached it as a sparse update for a row it could not find — deferred, and
    /// the picker's whole stream held behind it for good. Here each device converts behind a pull
    /// (both are paired, so neither converts at launch) and announces what it derived, so each
    /// receives the other's rows whole — and B, pulling before A's announcement reaches it,
    /// converts its own pick independently, under the same names.
    #[test]
    fn a_pick_made_on_a_v51_device_after_the_climb_converges_with_nothing_deferred() {
        use crate::sync_engine::apply::apply;
        let (a, b) = (paired_as("dev-a"), paired_as("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        crate::schema::fixtures::deck(&a, "Tokens");
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);
        let deck_b: i64 = b
            .query_row("SELECT id FROM decks", [], |r| r.get(0))
            .unwrap();

        // A climbs: its launch waits, and its first pull at v52 has nothing to convert.
        convert_legacy_picks_at_launch(&a).unwrap();
        pulled(&a, &[]);
        // B, still on v51, picks an art; A converts it on the pull that brings it.
        seed_pick(&b, deck_b, &treasure(), None, "u-pick");
        pulled(&a, &since(&b, &mut mb));
        assert_eq!(
            named_entries(&a).len(),
            2,
            "converted on the pull, not a launch later"
        );
        // B upgrades, and its first pull lands before A's announcement has reached the relay:
        // it converts its own pick.
        convert_legacy_picks_at_launch(&b).unwrap();
        assert_eq!(named_entries(&b), [], "a paired launch waits for a pull");
        pulled(&b, &[]);
        // B steps its live entry: the sparse op that used to stall.
        b.execute(
            "UPDATE deck_token_printings SET quantity = 4 WHERE variant = 'live'",
            [],
        )
        .unwrap();

        let (to_a, to_b) = (since(&b, &mut mb), since(&a, &mut ma));
        assert_eq!(
            unwritten(pulled(&a, &to_a)),
            (0, 0),
            "B's step finds A's row"
        );
        assert_eq!(
            unwritten(pulled(&b, &to_b)),
            (0, 0),
            "and A's announcements find B's"
        );
        let (on_a, on_b) = (named_entries(&a), named_entries(&b));
        assert_eq!(on_a, on_b, "both devices hold the same entries by name");
        let names: Vec<&str> = on_a.iter().map(|r| r.4.as_str()).collect();
        assert_eq!(names, ["u-pick-live", "u-pick-theory"]);
        for c in [&a, &b] {
            let pick: Option<String> = c
                .query_row("SELECT card_id FROM deck_tokens", [], |r| r.get(0))
                .unwrap();
            assert_eq!(pick, None, "the pick is legacy on both");
        }
    }

    /// **Two devices, an art reset on the v51 one after the other converted, and no op left
    /// deferred** — the reverse stall. The converting device holds `<uid>-live`, which the v51
    /// device will never derive once its pick is gone; under the rung-time conversion the
    /// converter's later count steps reached it as sparse updates for a row it did not have, and
    /// the converter's stream stalled there for good. The announced insert is what the other
    /// device builds the row from, on its first pull at v52. The reset itself is lost in that
    /// window, which is accepted.
    #[test]
    fn an_art_reset_on_a_v51_device_after_the_conversion_leaves_nothing_deferred() {
        use crate::sync_engine::apply::apply;
        let (a, b) = (paired_as("dev-a"), paired_as("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        let deck_a = crate::schema::fixtures::deck(&a, "Tokens");
        seed_pick(&a, deck_a, &treasure(), Some(3), "u-pick");
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);

        // A climbs and converts behind its first pull. B, still on v51, holds A's stream at the
        // first entry op.
        convert_legacy_picks_at_launch(&a).unwrap();
        pulled(&a, &[]);
        // B resets the art. A steps its live entry.
        b.execute(
            "UPDATE deck_tokens SET card_id = NULL WHERE sync_uid = 'u-pick'",
            [],
        )
        .unwrap();
        a.execute(
            "UPDATE deck_token_printings SET quantity = 5 WHERE variant = 'live'",
            [],
        )
        .unwrap();
        // B upgrades: its launch waits, and its first pull brings A's entries, step and clear.
        convert_legacy_picks_at_launch(&b).unwrap();
        let (to_a, to_b) = (since(&b, &mut mb), since(&a, &mut ma));
        assert_eq!(
            unwritten(pulled(&b, &to_b)),
            (0, 0),
            "A's step finds the row A announced"
        );
        assert_eq!(unwritten(pulled(&a, &to_a)), (0, 0));
        assert_eq!(named_entries(&a), named_entries(&b));
        assert_eq!(named_entries(&b).len(), 2, "B holds both of A's entries");
    }

    /// **A laggard's conversion never reverts an edit made since** — the fifth review round's
    /// finding, and the reason the conversion has a gate. A climbs and converts a pick at 3, then
    /// steps the live entry to 5. B, still on v51, pulls A's batch and defers it (a table it does
    /// not know, with A's clear held behind the entries), but its clock observes every stamp in
    /// it, deferred ones included — which is what the clock copy below stands for, because a v52
    /// fixture cannot defer a table it knows. When B climbs, a conversion at launch inserted
    /// `u-pick-live` at 3 under a later stamp than A's step, and last-writer-wins took both
    /// devices back to 3: **3 on both, measured with the gate switched off**. Behind B's first
    /// pull, A's entries and A's clear arrive first, B has no pick left to convert, and A's 5
    /// stands everywhere.
    #[test]
    fn a_laggards_conversion_never_reverts_an_edit_made_since() {
        use crate::sync_engine::apply::apply;
        let (a, b) = (paired_as("dev-a"), paired_as("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        let deck_a = crate::schema::fixtures::deck(&a, "Tokens");
        seed_pick(&a, deck_a, &treasure(), Some(3), "u-pick");
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);

        // A climbs, converts behind its first pull, and the reader steps the live entry to 5.
        convert_legacy_picks_at_launch(&a).unwrap();
        pulled(&a, &[]);
        a.execute(
            "UPDATE deck_token_printings SET quantity = 5 WHERE variant = 'live'",
            [],
        )
        .unwrap();
        let to_b = since(&a, &mut ma);
        // B, on v51, defers A's batch — and its clock observes the batch's stamps all the same.
        let (ms, ctr): (i64, i64) = a
            .query_row("SELECT ms, ctr FROM sync_clock WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        b.execute(
            "UPDATE sync_clock SET ms = max(ms, ?1), ctr = ?2 + 1 WHERE id = 1",
            params![ms, ctr],
        )
        .unwrap();

        // B climbs: its launch, then its first pull at v52, which brings A's batch.
        convert_legacy_picks_at_launch(&b).unwrap();
        assert_eq!(unwritten(pulled(&b, &to_b)), (0, 0));
        // Both ways, until each has heard everything the other said.
        assert_eq!(unwritten(pulled(&a, &since(&b, &mut mb))), (0, 0));
        assert_eq!(unwritten(pulled(&b, &since(&a, &mut ma))), (0, 0));

        let want = vec![
            ("u-pick-live".to_owned(), 5),
            ("u-pick-theory".to_owned(), 3),
        ];
        assert_eq!(counts(&a), want, "A's step stands on A");
        assert_eq!(counts(&b), want, "and on B");
    }

    /// **A device in no sync group converts at launch**, as it always did — there is no group to
    /// hear, and its writes record no op for anyone to race.
    #[test]
    fn an_unpaired_device_converts_at_launch() {
        let conn = open();
        crate::sync_engine::capture::install(&conn).unwrap();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(2), "u-pick");

        convert_legacy_picks_at_launch(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 2),
                e("theory", treasure().oracle_id, treasure().id, "nonfoil", 2),
            ]
        );
        assert_eq!(stored(&conn, deck)[0].1, None, "and the pick is cleared");
    }

    /// **A nameless pick on a paired device is named, converted, and stalls no peer.** Only a
    /// write behind `capture::suppressed` leaves a `deck_tokens` row with no `sync_uid`. The
    /// conversion used to leave it nameless and capture its clear, whose update trigger put the
    /// NULL into `sync_ops.uid NOT NULL` and failed the whole pass. It is named with the insert
    /// trigger's own mint first — no op, `sync_uid` is on no capture spec — and its clear goes
    /// uncaptured, because a pick never announced under any name has no peer that could find a
    /// sparse clear for it: captured, the clear is a row the peer cannot build, skipped and
    /// recorded there since 2026-09-27 — deferred before that, with this device's later ops in
    /// the page lost behind it. The entries are announced whole, and the peer builds both.
    #[test]
    fn a_nameless_pick_on_a_paired_device_is_named_and_stalls_no_peer() {
        use crate::sync_engine::apply::apply;
        let (a, b) = (paired_as("dev-a"), paired_as("dev-b"));
        let (mut ma, mut mb) = (0, 0);
        let deck_a = crate::schema::fixtures::deck(&a, "Tokens");
        apply(&b, &since(&a, &mut ma)).unwrap();
        let _ = since(&b, &mut mb);
        crate::sync_engine::capture::suppressed(&a, || {
            a.execute(
                "INSERT INTO deck_tokens
                     (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 3, 'auto', 0, 0)",
                params![deck_a, treasure().oracle_id, treasure().id],
            )
        })
        .unwrap();

        convert_legacy_picks(&a).unwrap();

        let pick: String = a
            .query_row("SELECT sync_uid FROM deck_tokens", [], |r| r.get(0))
            .expect("the pick is named");
        let names: Vec<String> = named_entries(&a).into_iter().map(|r| r.4).collect();
        assert_eq!(names, [format!("{pick}-live"), format!("{pick}-theory")]);
        assert_eq!(stored(&a, deck_a)[0].1, None, "and cleared");
        let ops = since(&a, &mut ma);
        let tables: Vec<&str> = ops.iter().map(|op| op.table.as_str()).collect();
        assert_eq!(
            tables,
            ["deck_token_printings", "deck_token_printings"],
            "the two entries announced, and no clear for a name no peer holds"
        );
        assert_eq!(
            unwritten(apply(&b, &ops).unwrap()),
            (0, 0),
            "the peer builds both"
        );
        assert_eq!(named_entries(&b), named_entries(&a));
    }

    /// **A pick that fails is skipped, and every other pick converts.** One savepoint per pick:
    /// a refused write rolls back that pick's entries alone, leaves its pick set to be tried again,
    /// and returns `Ok` — where one transaction over the file rolled back every conversion in it,
    /// at every launch, for as long as the one pick kept failing. The Treasure sorts first, so the
    /// Goblin converting proves a failure does not stop the walk.
    #[test]
    fn a_pick_that_fails_is_skipped_and_every_other_pick_converts() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(2), "u-treasure");
        seed_pick(&conn, deck, &goblin(), Some(1), "u-goblin");
        conn.execute_batch(&format!(
            "CREATE TEMP TRIGGER refuse_treasure BEFORE INSERT ON deck_token_printings
               WHEN NEW.card_id = '{}'
             BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            treasure().id
        ))
        .unwrap();

        convert_legacy_picks(&conn).unwrap();

        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", goblin().oracle_id, goblin().id, "nonfoil", 1),
                e("theory", goblin().oracle_id, goblin().id, "nonfoil", 1),
            ],
            "the Goblin converted; the Treasure left nothing half-written"
        );
        let picks: Vec<Option<String>> = stored(&conn, deck).into_iter().map(|r| r.1).collect();
        assert_eq!(
            picks,
            [Some(treasure().id.to_owned()), None],
            "the refused pick is still set, to be tried again"
        );

        conn.execute_batch("DROP TRIGGER temp.refuse_treasure")
            .unwrap();
        convert_legacy_picks(&conn).unwrap();
        assert_eq!(
            entries(&conn, deck).len(),
            4,
            "and the next run converts it"
        );
        assert!(stored(&conn, deck).iter().all(|r| r.1.is_none()));
    }

    /// **Two wrong finishes of one printing in one list fold into the lower uid** — apply's `min`
    /// rule, so every device keeps the same row. The repair runs behind `suppressed` on each
    /// device over the same synced rows; without an order, which of the two survived was each
    /// device's own row order, and two devices could keep the entry under two different names.
    /// The higher uid is inserted first, so an unordered walk meets it first and keeps it.
    #[test]
    fn the_finish_repair_folds_two_wrong_finishes_into_the_lower_uid() {
        let conn = paired();
        let foil_only = Card {
            id: "c-treasure-foil-only",
            finishes: r#"["foil"]"#,
            ..treasure()
        };
        foil_only.insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        for (finish, quantity, uid) in [("nonfoil", 2, "u-b"), ("etched", 1, "u-a")] {
            conn.execute(
                "INSERT INTO deck_token_printings
                     (deck_id, variant, oracle_id, card_id, finish, quantity, created_at,
                      updated_at, sync_uid)
                 VALUES (?1, 'live', ?2, ?3, ?4, ?5, 0, 0, ?6)",
                params![
                    deck,
                    foil_only.oracle_id,
                    foil_only.id,
                    finish,
                    quantity,
                    uid
                ],
            )
            .unwrap();
        }
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        repair_entry_finishes(&conn).unwrap();

        assert_eq!(
            named_entries(&conn),
            vec![(
                "live".to_owned(),
                foil_only.id.to_owned(),
                "foil".to_owned(),
                3,
                "u-a".to_owned()
            )],
            "one foil entry holding both counts, under the lower uid"
        );
        assert_eq!(
            recorded(&conn),
            [],
            "and nothing announced: each device repairs its own"
        );
    }

    /// **An undo rewrites an entry it keeps in place, so the entry keeps its name.** A token step
    /// records every entry of the token on both sides, and an `Op::Tokens` that deleted them all
    /// and inserted them again would hand each a fresh `sync_uid` — a tombstone and a put on the
    /// wire for every entry a step merely re-counted, and a row a peer still names by the old uid
    /// which add-wins can resurrect beside the new one, on the same grain. Checked on a stepper's
    /// undo and redo, and on a swap's undo, whose third entry the swap never touched.
    #[test]
    fn an_undo_rewrites_the_entries_it_keeps_in_place_and_keeps_their_uids() {
        let conn = paired();
        let (deck, _, _) = tithe_deck(&conn);
        seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(&conn, deck, "live", &treasure_older(), "nonfoil", 1);
        let uids = |c: &Connection| -> Vec<(String, String, String)> {
            c.prepare(
                "SELECT card_id, finish, sync_uid FROM deck_token_printings
                  WHERE deck_id = ?1 ORDER BY card_id, finish",
            )
            .unwrap()
            .query_map(params![deck], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let named = uids(&conn);
        assert_eq!(named.len(), 2);

        set_quantity(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            Some(&treasure_key(&treasure(), "nonfoil")),
            5,
        )
        .unwrap();
        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert_eq!(
            uids(&conn),
            named,
            "the undo re-counted both entries in place"
        );
        crate::deck_undo::apply_reversal(&conn, deck, audit, false).unwrap();
        assert_eq!(uids(&conn), named, "and so did the redo");

        swap(
            &conn,
            deck,
            "live",
            treasure().oracle_id,
            Some(&treasure_key(&treasure(), "nonfoil")),
            &treasure_key(&treasure_older(), "foil"),
        )
        .unwrap();
        let untouched = uids(&conn)
            .into_iter()
            .find(|(card, finish, _)| card == treasure_older().id && finish == "nonfoil")
            .expect("the swap leaves the third entry where it was");
        let audit = crate::deck_undo::next_undo(&conn, deck).unwrap().unwrap();
        crate::deck_undo::apply_reversal(&conn, deck, audit, true).unwrap();
        assert!(
            uids(&conn).contains(&untouched),
            "the swap's undo never touched the entry the swap never touched"
        );
    }

    // ── The layout predicate ─────────────────────────────────────────────────────────

    #[test]
    fn a_token_layout_is_one_of_the_three() {
        for layout in ["token", "double_faced_token", "emblem"] {
            assert!(is_token_layout(layout), "{layout}");
        }
        for layout in ["normal", "flip", "reversible_card", "meld", ""] {
            assert!(!is_token_layout(layout), "{layout}");
        }
    }

    /// **The routing predicate: a layout, or a two-sided layout whose line says `Token`.** Each
    /// line below is one the corpus stores (debug corpus, 2026-09-26), except the one marked.
    #[test]
    fn a_token_printing_is_a_token_layout_or_a_two_sided_token_line() {
        let yes: [(&str, Option<&str>); 6] = [
            ("token", Some("Token Artifact — Treasure")),
            ("double_faced_token", None),
            ("emblem", Some("Emblem — Elspeth")),
            (
                "flip",
                Some("Token Enchantment — Aura Role // Token Enchantment — Aura Role"),
            ),
            (
                "reversible_card",
                Some("Token Legendary Artifact Creature — Construct"),
            ),
            // Not in the corpus: the "any face" half, a token on the second face alone.
            ("flip", Some("Creature — Human // Token Creature — Spirit")),
        ];
        for (layout, line) in yes {
            assert!(is_token_printing(layout, line), "{layout} {line:?}");
        }
        let no: [(&str, Option<&str>); 6] = [
            ("reversible_card", Some("Legendary Creature — Elf Druid")),
            ("reversible_card", Some("Basic Land — Plains")),
            (
                "flip",
                Some("Creature — Human Monk // Legendary Creature — Spirit"),
            ),
            ("reversible_card", None),
            // A `Token` line on a layout outside the two is never read as one.
            ("normal", Some("Token Creature — Goblin")),
            ("normal", Some("Instant")),
        ];
        for (layout, line) in no {
            assert!(!is_token_printing(layout, line), "{layout} {line:?}");
        }

        let conn = open();
        treasure().insert(&conn);
        tithe().insert(&conn);
        assert!(printing_is_token(&conn, treasure().id).unwrap());
        assert!(!printing_is_token(&conn, tithe().id).unwrap());
        assert!(!printing_is_token(&conn, "c-nowhere").unwrap());
    }

    /// `Mechtitan`, the corpus's one `reversible_card` token — a layout-only test refuses it, and
    /// `deck::add_card` would then have filed it as a deck card.
    fn mechtitan() -> Card<'static> {
        Card {
            id: "c-mechtitan",
            oracle_id: "o-mechtitan",
            name: "Mechtitan // Mechtitan",
            type_line: "Token Legendary Artifact Creature — Construct",
            layout: "reversible_card",
            power: Some("10"),
            toughness: Some("10"),
            colors: "WUBRG",
            set_code: "tneo",
            collector_number: "20",
            released_at: "2022-02-18",
            ..Card::default()
        }
    }

    /// **A two-sided token is accepted and a two-sided card is refused** — the `reversible_card`
    /// `Mechtitan` becomes a hand-added token entry, and a reversible legendary creature is
    /// [`NOT_A_TOKEN`] with nothing written.
    #[test]
    fn a_reversible_token_is_added_and_a_reversible_card_is_refused() {
        let conn = open();
        mechtitan().insert(&conn);
        let legend = Card {
            id: "c-reversible-legend",
            oracle_id: "o-reversible-legend",
            name: "A Reversible Legend",
            type_line: "Legendary Creature — Elf Druid",
            layout: "reversible_card",
            ..Card::default()
        };
        legend.insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        assert_eq!(
            add_printing(&conn, deck, "live", legend.id, None),
            Err(NOT_A_TOKEN.to_owned())
        );
        assert!(
            entries(&conn, deck).is_empty(),
            "the refused card wrote nothing"
        );

        assert_eq!(
            add_printing(&conn, deck, "live", mechtitan().id, None).unwrap(),
            1
        );
        assert_eq!(
            entries(&conn, deck),
            vec![e("live", "o-mechtitan", "c-mechtitan", "nonfoil", 1)]
        );
        assert_eq!(rows(&conn, deck)[0].state, "manual");
    }

    // ── Every token printing ─────────────────────────────────────────────────────────

    /// **Every paper token and emblem printing, and nothing else — held to
    /// [`is_listed_token`]**, so the SQL predicate and the Rust one cannot come to disagree
    /// about which cards the All tokens picker offers. A token, an emblem, a double-faced token, a
    /// `flip` Role, the `reversible_card` Mechtitan, and two-sided printings whose token or emblem
    /// is on the back face only are in; a normal card, a Kamigawa-style `flip` card, a reversible
    /// legend and a digital-only token are out. Ordered by token name, then by `oracle_id`, then
    /// newest printing first — the picker's grouping.
    #[test]
    fn token_printings_answers_every_token_and_nothing_else() {
        let conn = open();
        let dfc = Card {
            id: "c-dfc-token",
            oracle_id: "o-dfc-token",
            name: "Human Soldier // Spirit",
            type_line: "Token Creature — Human Soldier // Token Creature — Spirit",
            layout: "double_faced_token",
            ..Card::default()
        };
        let role = Card {
            id: "c-role",
            oracle_id: "o-role",
            name: "Royal // Young Hero",
            type_line: "Token Enchantment — Aura Role // Token Enchantment — Aura Role",
            layout: "flip",
            ..Card::default()
        };
        // Two synthetic shapes for the back-face arms (`% // Token%`, `% // Emblem%`): no printing
        // in the corpus is a card on the front and a token or an emblem only on the back, and
        // these are what hold the SQL's "any face" to the Rust's.
        let token_back = Card {
            id: "c-token-back",
            oracle_id: "o-token-back",
            name: "Kami of the Back Face // Spirit",
            type_line: "Creature — Human // Token Creature — Spirit",
            layout: "flip",
            ..Card::default()
        };
        let emblem_back = Card {
            id: "c-emblem-back",
            oracle_id: "o-emblem-back",
            name: "Planeswalker of the Back Face // Emblem",
            type_line: "Legendary Planeswalker — Tester // Emblem — Tester",
            layout: "reversible_card",
            ..Card::default()
        };
        let flip_card = Card {
            id: "c-flip-card",
            oracle_id: "o-flip-card",
            name: "A Flip Card",
            type_line: "Creature — Human Monk // Legendary Creature — Spirit",
            layout: "flip",
            ..Card::default()
        };
        let legend = Card {
            id: "c-reversible-legend",
            oracle_id: "o-reversible-legend",
            name: "A Reversible Legend",
            type_line: "Legendary Creature — Elf Druid",
            layout: "reversible_card",
            ..Card::default()
        };
        let digital = Card {
            id: "c-treasure-digital",
            released_at: "2024-01-01",
            ..treasure()
        };
        let all = [
            treasure(),
            treasure_older(),
            elspeth_emblem(),
            dfc.clone(),
            role.clone(),
            mechtitan(),
            token_back.clone(),
            emblem_back.clone(),
            tithe(),
            flip_card.clone(),
            legend.clone(),
            digital.clone(),
        ];
        for card in &all {
            card.insert(&conn);
        }
        conn.execute(
            "UPDATE cards SET is_paper = 0 WHERE id = ?1",
            params![digital.id],
        )
        .unwrap();

        let got = list_token_printings(&conn, Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            got.iter()
                .map(|p| (p.name.as_str(), p.printing.id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("Elspeth, Sun's Champion Emblem", elspeth_emblem().id),
                ("Human Soldier // Spirit", dfc.id),
                ("Kami of the Back Face // Spirit", token_back.id),
                ("Mechtitan // Mechtitan", mechtitan().id),
                ("Planeswalker of the Back Face // Emblem", emblem_back.id),
                ("Royal // Young Hero", role.id),
                ("Treasure", treasure().id),
                ("Treasure", treasure_older().id),
            ],
            "by name, then newest printing first"
        );
        for card in &all {
            let answered = got.iter().find(|p| p.printing.id == card.id);
            assert_eq!(
                answered.is_some(),
                card.id != digital.id
                    && is_listed_token(
                        card.layout,
                        Some(card.type_line),
                        Some(card.oracle_text),
                        None
                    ),
                "`{}` must be answered exactly when the predicate says it is a paper token",
                card.name
            );
            if let Some(p) = answered {
                assert_eq!(p.oracle_id, card.oracle_id, "{}", card.name);
            }
        }
        let newest_treasure = got.iter().find(|p| p.printing.id == treasure().id).unwrap();
        assert_eq!(
            newest_treasure.printing.finish_prices.nonfoil,
            Some(0.25),
            "priced the way the printings picker prices one"
        );
    }

    /// **All tokens keeps the game helpers and leaves out other games' cards** — the reader's rule
    /// of 2026-09-28, after a day on which it listed only `Token` and `Emblem` faces and so lost
    /// The Monarch with the World Championships ads (the live pass had found the wall opening on
    /// two of those). Each fixture is a shape off the debug corpus, text and set type included:
    ///
    /// - **In:** The Monarch (`Card`), Day // Night (`Card // Card`), a face-down Manifest
    ///   (`Creature`, kept by its reminder text), and a real double-faced token, Treasure, an
    ///   emblem and Mechtitan beside them.
    /// - **Out:** a deck ad and a challenge deck's Minotaur (both `memorabilia` sets), a minigame
    ///   (`minigame`), a set checklist (`Card`, but its text is a proxy's), and a TMNT arena boss (a
    ///   `token` set, whose `Boss` line is neither a helper face nor a face-down card).
    ///
    /// Every fixture is also asked of [`is_listed_token`], so the SQL and the Rust stay one rule.
    #[test]
    fn token_printings_keeps_the_game_helpers_and_leaves_out_other_games() {
        let conn = open();
        let set_types = [
            ("wc97", "memorabilia"),
            ("tbth", "memorabilia"),
            ("mkhm", "minigame"),
            ("tcmm", "token"),
            ("tmid", "token"),
            ("tc18", "token"),
            ("tisd", "token"),
            ("ttmc", "token"),
        ];
        for (code, set_type) in set_types {
            conn.execute(
                "INSERT INTO sets (code, name, set_type) VALUES (?1, ?1, ?2)",
                params![code, set_type],
            )
            .unwrap();
        }
        let set_type_of = |code: &str| set_types.iter().find(|(c, _)| *c == code).map(|(_, t)| *t);
        let ad = Card {
            id: "c-wc97-ad",
            oracle_id: "o-wc97-ad",
            name: "1997 World Championships Ad",
            type_line: "Card",
            layout: "token",
            set_code: "wc97",
            collector_number: "0",
            ..Card::default()
        };
        let minotaur = Card {
            id: "c-minotaur",
            oracle_id: "o-minotaur",
            name: "Minotaur Goreseeker",
            type_line: "Creature — Minotaur",
            layout: "token",
            oracle_text: "Haste\nMinotaur Goreseeker attacks each turn if able.",
            set_code: "tbth",
            ..Card::default()
        };
        let minigame = Card {
            id: "c-booster-sleuth",
            oracle_id: "o-booster-sleuth",
            name: "Booster Sleuth // Booster Sleuth (cont'd)",
            type_line: "Card // Card",
            layout: "double_faced_token",
            set_code: "mkhm",
            ..Card::default()
        };
        let checklist = Card {
            id: "c-isd-checklist",
            oracle_id: "o-isd-checklist",
            name: "Innistrad Checklist",
            type_line: "Card",
            layout: "token",
            oracle_text: "(You can mark this card to represent a double-faced card in your \
                          library. Put the double-faced card aside until it enters the battlefield.)",
            set_code: "tisd",
            ..Card::default()
        };
        let boss = Card {
            id: "c-shredder",
            oracle_id: "o-shredder",
            name: "Shredder, Foot Clan Overlord",
            type_line: "Boss",
            layout: "token",
            oracle_text: "Whenever a creature the bosses control dies, the heroes lose 1 life.",
            set_code: "ttmc",
            ..Card::default()
        };
        let monarch = Card {
            id: "c-monarch",
            oracle_id: "o-monarch",
            name: "The Monarch",
            type_line: "Card",
            layout: "token",
            oracle_text: "At the beginning of your end step, draw a card.\nWhenever a creature \
                          deals combat damage to you, its controller becomes the monarch.",
            set_code: "tcmm",
            ..Card::default()
        };
        let day_night = Card {
            id: "c-day-night",
            oracle_id: "o-day-night",
            name: "Day // Night",
            type_line: "Card // Card",
            layout: "double_faced_token",
            set_code: "tmid",
            ..Card::default()
        };
        let manifest = Card {
            id: "c-manifest",
            oracle_id: "o-manifest",
            name: "Manifest",
            type_line: "Creature",
            layout: "token",
            power: Some("2"),
            toughness: Some("2"),
            oracle_text: "(You can cover a face-down manifested creature with this reminder \
                          card. A manifested creature card can be turned face up any time for \
                          its mana cost.)",
            set_code: "tc18",
            ..Card::default()
        };
        // A dungeon's line is never `Card`, and is a helper by its `Dungeon` face (#670).
        let tomb = Card {
            id: "c-tomb",
            oracle_id: "o-tomb",
            name: "Tomb of Annihilation",
            type_line: "Dungeon — Tomb of Annihilation",
            layout: "token",
            set_code: "tafr",
            ..Card::default()
        };
        let dfc = Card {
            id: "c-dfc-token",
            oracle_id: "o-dfc-token",
            name: "Human Soldier // Spirit",
            type_line: "Token Creature — Human Soldier // Token Creature — Spirit",
            layout: "double_faced_token",
            ..Card::default()
        };
        let all = [
            ad.clone(),
            minotaur.clone(),
            minigame.clone(),
            checklist.clone(),
            boss.clone(),
            monarch.clone(),
            day_night.clone(),
            manifest.clone(),
            tomb.clone(),
            dfc.clone(),
            treasure(),
            elspeth_emblem(),
            mechtitan(),
        ];
        for card in &all {
            card.insert(&conn);
        }

        let got = list_token_printings(&conn, Marketplace::Tcgplayer).unwrap();
        let names: Vec<&str> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Day // Night",
                "Elspeth, Sun's Champion Emblem",
                "Human Soldier // Spirit",
                "Manifest",
                "Mechtitan // Mechtitan",
                "The Monarch",
                "Tomb of Annihilation",
                "Treasure",
            ],
            "the helpers in, and the ad, the Minotaur, the minigame, the checklist and the boss out"
        );
        for card in &all {
            assert_eq!(
                got.iter().any(|p| p.printing.id == card.id),
                is_listed_token(
                    card.layout,
                    Some(card.type_line),
                    Some(card.oracle_text),
                    set_type_of(card.set_code),
                ),
                "`{}`: the SQL and the Rust must give one answer",
                card.name
            );
        }
    }

    /// **A `sets` row with no code leaves out no helper.** `sets.code` is a `TEXT PRIMARY KEY`
    /// with no `NOT NULL`, so SQLite lets a row hold a NULL one — and against a set holding a
    /// NULL, `x NOT IN (…)` is never true, only NULL or false. Written as a `NOT IN` over the
    /// other games' codes, one nameless `minigame` row dropped every helper from All tokens while
    /// [`is_listed_token`] kept them all. The correlated `NOT EXISTS` asks each card's own set and
    /// nothing else, so a card whose set `sets` does not list is kept, as it always was.
    #[test]
    fn token_printings_keeps_the_helpers_when_a_set_has_no_code() {
        let conn = open();
        conn.execute(
            "INSERT INTO sets (code, name, set_type) VALUES ('tcmm', 'tcmm', 'token'),
                                                           (NULL, 'Nameless', 'minigame')",
            [],
        )
        .unwrap();
        let nulls: i64 = conn
            .query_row("SELECT count(*) FROM sets WHERE code IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(nulls, 1, "the fixture really holds a set with no code");
        let monarch = Card {
            id: "c-monarch",
            oracle_id: "o-monarch",
            name: "The Monarch",
            type_line: "Card",
            layout: "token",
            oracle_text: "At the beginning of your end step, draw a card.",
            set_code: "tcmm",
            ..Card::default()
        };
        // In a set `sets` does not list at all: a helper in doubt is kept.
        let unlisted = Card {
            id: "c-day-night",
            oracle_id: "o-day-night",
            name: "Day // Night",
            type_line: "Card // Card",
            layout: "double_faced_token",
            set_code: "zzzz",
            ..Card::default()
        };
        for card in [&monarch, &unlisted] {
            card.insert(&conn);
        }
        treasure().insert(&conn);

        let got = list_token_printings(&conn, Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            got.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["Day // Night", "The Monarch", "Treasure"],
            "both helpers listed beside the token"
        );
        for card in [&monarch, &unlisted] {
            let set_type = (card.set_code == "tcmm").then_some("token");
            assert!(
                is_listed_token(
                    card.layout,
                    Some(card.type_line),
                    Some(card.oracle_text),
                    set_type
                ),
                "`{}`: the Rust keeps it, so the SQL must",
                card.name
            );
        }
    }

    /// **A token printing on the wire is the picker's `Printing` with the token's own facts beside
    /// it** — the subtitle's colours, size and text, and the `oracleId` that groups it. `layout`
    /// is written **once**, the printing's: a flattened struct beside a field of the same name
    /// would write the key twice.
    #[test]
    fn a_token_printing_is_the_pickers_printing_with_the_tokens_facts_beside_it() {
        let conn = open();
        soldier().insert(&conn);
        let answer = list_token_printings(&conn, Marketplace::Tcgplayer).unwrap();
        let text = serde_json::to_string(&answer).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json[0]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "artist",
                "borderColor",
                "collectorNumber",
                "colors",
                "finishPrices",
                "finishes",
                "frameEffects",
                "fullArt",
                "id",
                "illustrationId",
                "lang",
                "layout",
                "name",
                "oracleId",
                "oracleText",
                "power",
                "promo",
                "promoTypes",
                "rarity",
                "releasedAt",
                "setCode",
                "setName",
                "toughness",
                "typeLine",
            ]
        );
        assert_eq!(json[0]["oracleId"], json!(soldier().oracle_id));
        assert_eq!(json[0]["id"], json!(soldier().id));
        assert_eq!(json[0]["power"], json!("1"), "a string, as on the wall");
        assert_eq!(json[0]["colors"], json!("W"), "letters, as on the wall");
        assert_eq!(json[0]["layout"], json!("token"));
        assert_eq!(text.matches("\"layout\":").count(), 1);
    }

    // ── The wire ─────────────────────────────────────────────────────────────────────

    /// The keys `packages/ui/lib/ipc.ts` reads, and the two value shapes that cannot be checked by a
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
                "collectorNumber",
                "colors",
                "defaultCardId",
                "derived",
                "finish",
                "finishes",
                "implicit",
                "layout",
                "name",
                "oracleId",
                "oracleText",
                "power",
                "quantity",
                "rarity",
                "setCode",
                "setName",
                "sources",
                "state",
                "toughness",
                "typeLine",
                "unitPrice",
            ]
        );
        assert_eq!(soldier_row["power"], json!("1"), "a string, never a number");
        // The chin: `finishes` is the column's JSON **text**, `parseFinishes`' input, and an
        // unpriced printing is `null` on the wire rather than `0` or an absent key.
        assert_eq!(soldier_row["finishes"], json!(r#"["nonfoil"]"#));
        assert_eq!(soldier_row["unitPrice"], serde_json::Value::Null);
        assert_eq!(soldier_row["colors"], json!("W"), "letters, never an array");
        // An implicit entry: a string `cardId`, a finish, a number, and a flag — never nulls.
        assert_eq!(soldier_row["cardId"], json!(soldier().id));
        assert_eq!(soldier_row["finish"], json!("nonfoil"));
        assert_eq!(soldier_row["quantity"], json!(0));
        assert_eq!(soldier_row["implicit"], json!(true));
        assert_eq!(soldier_row["state"], json!("auto"));
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

    /// The wire key a stepper and the picker send for an entry.
    #[test]
    fn an_entry_key_reads_the_camel_case_the_page_sends() {
        let key: TokenEntryKey =
            serde_json::from_value(json!({ "cardId": "c-1", "finish": "foil" })).unwrap();
        assert_eq!(
            key,
            treasure_key(
                &Card {
                    id: "c-1",
                    ..Card::default()
                },
                "foil"
            )
        );
        assert!(serde_json::from_value::<TokenEntryKey>(
            json!({ "card_id": "c-1", "finish": "foil" })
        )
        .is_err());
    }

    /// **The backstop**: a cut through `collection_alloc::deck_to_collection` files no undo step,
    /// so its transaction has nowhere to put a reconcile — and after `sync::with_write` returns
    /// the Treasure is settled anyway by the reconcile that rides every write: its entry at zero
    /// gone, and the one with copies kept as `manual`.
    #[test]
    fn the_backstop_reconciles_a_cut_that_files_no_step() {
        let state = crate::index::fixtures::state_with_seeded_cards("deck-tokens-backstop");
        let (deck, landed) = {
            let conn = crate::db::lock_blocking(&state.db);
            tithe().insert(&conn);
            tithe_other_printing().insert(&conn);
            treasure().insert(&conn);
            treasure_older().insert(&conn);
            let deck = crate::deck::create_deck(
                &conn,
                &crate::deck::DeckInput {
                    name: "Tithe".to_owned(),
                    format_key: "commander".to_owned(),
                    ..Default::default()
                },
            )
            .unwrap()
            .id;
            let landed = crate::deck::add_card(
                &conn,
                deck,
                tithe().id,
                None,
                Some("Main deck"),
                "live",
                None,
                1,
            )
            .unwrap()
            .id;
            seed_used_and_zero_treasure(&conn, deck);
            (deck, landed)
        };

        crate::state::with_write(&state, |c| {
            crate::collection_alloc::deck_to_collection(c, landed, 1).map(|_| ())
        })
        .unwrap();

        let conn = crate::db::lock_blocking(&state.db);
        assert_kept_as_manual(&conn, deck, "the backstop");
    }

    /// **A paired device converts nothing at launch until a pull at v52 has landed, and from
    /// then on converts at launch too.** The launch pass is where a paired device would convert
    /// before hearing its group; the pull half sets [`PICKS_READY`] and converts, and a pick that
    /// reaches the table afterwards by some other route is converted by the next launch.
    #[test]
    fn a_paired_device_converts_nothing_at_launch_before_its_first_pull() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(2), "u-pick");

        convert_legacy_picks_at_launch(&conn).unwrap();
        assert_eq!(entries(&conn, deck), [], "the launch waits for a pull");
        assert_eq!(
            stored(&conn, deck)[0].1.as_deref(),
            Some(treasure().id),
            "and the pick is still set"
        );

        pulled(&conn, &[]);
        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 2),
                e("theory", treasure().oracle_id, treasure().id, "nonfoil", 2),
            ],
            "the first pull converts"
        );
        assert_eq!(
            crate::sync_engine::client::get_state(&conn, PICKS_READY).as_deref(),
            Some("1")
        );

        seed_pick(&conn, deck, &goblin(), Some(1), "u-goblin");
        convert_legacy_picks_at_launch(&conn).unwrap();
        assert_eq!(
            entries(&conn, deck).len(),
            4,
            "a launch after that pull converts again"
        );
    }
}

/// **The test scaffolding this module's tests share with the ones `src-tauri` still holds** —
/// behind the `testing` feature, which no build ships. At the foot of the file, below
/// `mod tests`, because `scripts/coverage-rust.mjs` counts everything from the first column-0
/// `#[cfg(test)]` down as test code.
#[cfg(any(test, feature = "testing"))]
pub mod fixtures {
    use super::*;
    use rusqlite::{params, Connection};
    use serde_json::json;

    /// One `cards` row, written by hand.
    ///
    /// **Every fixture below lives in a `:memory:` pair that is dropped when the test returns**,
    /// which is the strongest available form of "delete the rows afterwards": nothing here can
    /// reach `data/user.db` or `data/corpus.db`, so no hand-written `cards` row can make a later
    /// measurement a fiction.
    #[derive(Clone)]
    pub struct Card<'a> {
        pub id: &'a str,
        pub oracle_id: &'a str,
        pub name: &'a str,
        pub type_line: &'a str,
        pub layout: &'a str,
        pub power: Option<&'a str>,
        pub toughness: Option<&'a str>,
        /// Concatenated letters, the way `card_row` stores them: `"W"`, `"BGRUW"`, `""`.
        pub colors: &'a str,
        pub oracle_text: &'a str,
        pub set_code: &'a str,
        pub collector_number: &'a str,
        pub released_at: &'a str,
        pub set_name: &'a str,
        pub rarity: &'a str,
        /// The JSON text `card_row` stores in `cards.finishes`: `["nonfoil"]`, `["foil"]`.
        pub finishes: &'a str,
        /// Scryfall's `prices` object as `cards.prices` holds it — decimal **strings** and
        /// nulls, which is what [`crate::sorting::price_expr`]'s `CAST` is there for.
        pub prices: &'a str,
        /// `all_parts` entries as `(id, component, name)`.
        pub parts: &'a [(&'a str, &'a str, &'a str)],
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
                set_name: "Test Set",
                rarity: "common",
                finishes: r#"["nonfoil"]"#,
                // Unpriced everywhere: every existing fixture predates the price and said
                // nothing about one.
                prices: "{}",
                parts: &[],
            }
        }
    }

    impl Card<'_> {
        /// The `raw` blob this card would have been ingested as — gzip, as schema v3 on stores
        /// it, so the fixture exercises [`crate::card_row::raw_json`]'s real path rather than
        /// the plain-text one only a pre-sync database has.
        pub fn raw(&self) -> Vec<u8> {
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
            // The text a marker is read off (#670), where the blob carries it.
            if !self.oracle_text.is_empty() {
                body["oracle_text"] = json!(self.oracle_text);
            }
            if !self.parts.is_empty() {
                body["all_parts"] = json!(parts);
            }
            crate::card_row::gzip_raw(&body.to_string())
        }

        pub fn insert(&self, conn: &Connection) {
            self.insert_raw(conn, &self.raw());
        }

        /// The same row with a `raw` of the caller's choosing — the four failure shapes.
        pub fn insert_raw(&self, conn: &Connection, raw: &[u8]) {
            conn.execute(
                "INSERT INTO cards
                     (id, oracle_id, name, type_line, layout, power, toughness, colors,
                      oracle_text, set_code, collector_number, lang, released_at, raw,
                      set_name, rarity, finishes, prices)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'en',?12,?13,?14,?15,?16,?17)",
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
                    self.set_name,
                    self.rarity,
                    self.finishes,
                    self.prices,
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
    pub fn tithe() -> Card<'static> {
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

    /// The Treasure `Smothering Tithe` names — and the one fixture carrying a price, so the
    /// chin's tests have a figure to find.
    pub fn treasure() -> Card<'static> {
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
            set_name: "Commander Masters Tokens",
            rarity: "common",
            finishes: r#"["nonfoil"]"#,
            prices: r#"{"usd":"0.25"}"#,
            ..Card::default()
        }
    }

    /// The **other** printing of `Smothering Tithe` — the one its own `all_parts` self-entry
    /// points at. Same `oracle_id`, different `id`, and it has to exist in `cards` or a test
    /// about the keep rule would really be a test about an unresolvable id.
    pub fn tithe_other_printing() -> Card<'static> {
        Card {
            id: "da65d83c-67bd-4d54-9c9a-50d57ca115bb",
            set_code: "clb",
            collector_number: "297",
            released_at: "2022-06-10",
            ..tithe()
        }
    }

    pub fn goblin() -> Card<'static> {
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

    // ── The database the tests run against ────────────────────────────────────────────

    /// **`foreign_keys` is ON**, as [`crate::db::open`] sets it for every connection the app
    /// hands out: `deck_tokens.deck_id` CASCADEs off `decks`, and that is a per-connection
    /// setting. [`crate::schema::memory_pair`] already turns it on; this says so out loud.
    pub fn open() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// A deck with one active `main` pile and one inactive `maybe` pile.
    pub fn deck_with_piles(conn: &Connection) -> (i64, i64, i64) {
        let deck = crate::schema::fixtures::deck(conn, "Tokens");
        let main = crate::schema::fixtures::category(conn, deck, "main", "Main deck");
        let maybe = crate::schema::fixtures::category(conn, deck, "maybe", "Maybeboard");
        (deck, main, maybe)
    }

    // ── The stored state ─────────────────────────────────────────────────────────────

    /// Every `deck_tokens` row of one deck, `(oracle, card_id, quantity, state)`.
    pub fn stored(
        conn: &Connection,
        deck: i64,
    ) -> Vec<(String, Option<String>, Option<i64>, String)> {
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

    /// Every entry of one deck, `(variant, oracle, card, finish, quantity)`, in one order.
    pub fn entries(conn: &Connection, deck: i64) -> Vec<(String, String, String, String, i64)> {
        conn.prepare(
            "SELECT variant, oracle_id, card_id, finish, quantity FROM deck_token_printings
              WHERE deck_id = ?1 ORDER BY variant, oracle_id, card_id, finish",
        )
        .unwrap()
        .query_map(params![deck], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    /// One entry as [`entries`] reads it.
    pub fn e(
        variant: &str,
        oracle: &str,
        card: &str,
        finish: &str,
        quantity: i64,
    ) -> (String, String, String, String, i64) {
        (
            variant.to_owned(),
            oracle.to_owned(),
            card.to_owned(),
            finish.to_owned(),
            quantity,
        )
    }

    /// One entry written straight into the table — the state a test starts from, never the write
    /// under test.
    pub fn seed_entry(
        conn: &Connection,
        deck: i64,
        variant: &str,
        card: &Card<'_>,
        finish: &str,
        quantity: i64,
    ) {
        conn.execute(
            "INSERT INTO deck_token_printings
                 (deck_id, variant, oracle_id, card_id, finish, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)",
            params![deck, variant, card.oracle_id, card.id, finish, quantity],
        )
        .unwrap();
    }

    /// One token's `deck_tokens.state`, or `None` for no row.
    pub fn state_word(conn: &Connection, deck: i64, oracle: &str) -> Option<String> {
        conn.query_row(
            "SELECT state FROM deck_tokens WHERE deck_id = ?1 AND oracle_id = ?2",
            params![deck, oracle],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// The fixture every rule-7 hook test seeds: two live Treasure entries, **one with copies and
    /// one at zero** — the two halves of issue #671.
    pub fn seed_used_and_zero_treasure(conn: &Connection, deck: i64) {
        seed_entry(conn, deck, "live", &treasure(), "nonfoil", 2);
        seed_entry(conn, deck, "live", &treasure_older(), "foil", 0);
    }

    /// What a hook test asserts once the maker has gone: the Treasure at zero is deleted, the one
    /// with copies is kept, and the token is `manual` — drawn as not made by the deck.
    pub fn assert_kept_as_manual(conn: &Connection, deck: i64, context: &str) {
        assert_eq!(
            entries(conn, deck),
            vec![e("live", treasure().oracle_id, treasure().id, "nonfoil", 2)],
            "the entry at zero goes and the one with copies stays — {context}"
        );
        assert_eq!(
            state_word(conn, deck, treasure().oracle_id).as_deref(),
            Some(MANUAL_STATE),
            "and the Treasure is the reader's now — {context}"
        );
    }

    /// The Treasure's second printing — an older one, priced, with a foil — which is what a
    /// swap and an added printing have to name.
    pub fn treasure_older() -> Card<'static> {
        Card {
            id: "c-treasure-older",
            set_code: "tvow",
            collector_number: "17",
            released_at: "2021-11-19",
            set_name: "Crimson Vow Tokens",
            finishes: r#"["nonfoil","foil"]"#,
            prices: r#"{"usd":"1.50","usd_foil":"4.00"}"#,
            ..treasure()
        }
    }

    /// A database with the capture triggers installed **and a sync group**, so capture is live —
    /// `sync_engine::capture`'s own test fixture. The only fixture that can see a write that loses
    /// a row's `sync_uid`: an unpaired file mints uids the same way and records nothing to fail on.
    pub fn paired() -> Connection {
        paired_as("dev-a")
    }

    /// [`paired`] under a device id of the caller's choosing, so two of them can trade ops — the
    /// harness `sync_engine::apply`'s own two-device tests use.
    pub fn paired_as(device: &str) -> Connection {
        let conn = open();
        crate::sync_engine::capture::install(&conn).unwrap();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, ?1, x'00', x'01', ?1, 0)",
            [device],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, x'02', 0)",
            [],
        )
        .unwrap();
        conn
    }

    // ── The launch pass that retires a dismissal ─────────────────────────────────────

    pub fn ops(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
            .unwrap()
    }

    // ── The legacy conversion ────────────────────────────────────────────────────────

    /// One legacy pick, written straight into `deck_tokens` — what a v51 device's art picker left
    /// behind, or what `apply` writes when such a device's op arrives. The uid is the caller's, so
    /// a test can name the entries derived from it.
    pub fn seed_pick(
        conn: &Connection,
        deck: i64,
        card: &Card<'_>,
        quantity: Option<i64>,
        uid: &str,
    ) {
        conn.execute(
            "INSERT INTO deck_tokens
                 (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at, sync_uid)
             VALUES (?1, ?2, ?3, ?4, 'auto', 0, 0, ?5)",
            params![deck, card.oracle_id, card.id, quantity, uid],
        )
        .unwrap();
    }

    /// A pull at v52, as `sync_engine::client::pull` runs one: `apply` the ops, then the pull half
    /// of the conversion's gate behind them.
    pub fn pulled(
        conn: &Connection,
        ops: &[crate::sync_engine::merge::Op],
    ) -> crate::sync_engine::apply::ApplyReport {
        let report = crate::sync_engine::apply::apply(conn, ops).unwrap();
        convert_legacy_picks_after_pull(conn).unwrap();
        report
    }
}
