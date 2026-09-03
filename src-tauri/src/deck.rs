//! Decks: the gallery, the deck itself, and what sits in each of its categories.
//!
//! Shaped like [`crate::collection`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. Writes take
//! `AppState.db` through [`crate::db::lock_for`] and answer [`crate::db::BUSY`]
//! rather than waiting; the one read goes through `db_read` like every other read.
//!
//! Four rules run through the whole module and are worth stating once:
//!
//! * **A card is addressed by its category, never by a fixed word.** Schema v8 replaced
//!   `deck_cards.zone` with `category_id` — a row in [`crate::deck_meta`]'s `deck_categories`
//!   that the user names, orders, deactivates and deletes. What used to be a five-word enum
//!   is now data, and the only thing the rules still read off it is its `kind`.
//! * **An inactive category counts toward nothing** — not [`DeckRow::card_count`], not the
//!   validation engine's size or copy limits, and [`attribute_owned`] hands it no copy the deck
//!   holds. That is the whole of what the `maybe` zone used to mean, generalised: the
//!   Maybeboard is simply the one category seeded `is_active = 0`, and a category of the
//!   user's own that they switch off behaves identically. Nothing in this file asks whether a
//!   category *is* the Maybeboard.
//! * **A card write denormalizes the printing *and the name*.** `deck_cards.card_id` is a
//!   soft reference — `cards` is dropped and rebuilt on every sync — so the row records
//!   what it was made from at the only moment that is knowable. The name is here for the
//!   wishlist's reason: a deck list that cannot say what an orphaned row *is* is not a list.
//! * **Zero is a removal.** `deck_cards.quantity` carries `CHECK (quantity > 0)`, unlike the
//!   collection's, because a category slot at zero holds nothing worth keeping — no condition,
//!   no purchase price, no acquisition story, just an intention the user withdrew.
//!
//! Every card command takes a `variant` ([`crate::schema::DECK_VARIANTS`]) as well, because
//! v8 widened the grain: `live` is what is sleeved up, `theory` is what the deck is being
//! built toward, and an edit tried out in one must never fold into the other's row.
//!
//! And every write here leaves a line in [`crate::deck_audit`], **inside its own transaction**
//! — so a change that rolls back takes its history with it. The two exceptions say why on
//! their own docs: [`delete_deck`] (the row would CASCADE away with the deck it describes) and
//! [`missing_to_wishlist`] (it changes the wishlist, not the deck).

use crate::collection::{valid_quantity, EntryChange, ZERO_ADD};
use crate::deck_meta::{DeckCategoryRow, DeckLabelRow};
#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The variant this module means when it says "the deck": what is actually sleeved up.
///
/// [`DeckRow::card_count`], [`attribute_owned`] and [`missing_to_wishlist`] all read it and
/// nothing else. A theory list is a plan — it is counted on no tile, it is handed none of the
/// copies the deck holds, and it puts nothing on a shopping list, because a plan is not a deck
/// the user has.
/// `DECK_VARIANTS[0]` by index rather than by spelling, so the two cannot drift.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];

/// The other one: the list the deck is being built toward.
///
/// This module reads it in exactly one place — [`update_deck`]'s undo step, which has to record
/// **both** lists because switching the theory list on moves one into the other. `DeckPatch`'s
/// other fields never mention a variant, which is why this constant arrived so much later than
/// [`LIVE`]. `DECK_VARIANTS[1]` by index, for [`LIVE`]'s reason.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];

/// What a deck is in when nobody says otherwise — `decks.format_key`'s own DDL default, so
/// an omitted `formatKey` means here exactly what it means in SQL.
pub const DEFAULT_FORMAT: &str = "casual";

/// What platform a deck is for when nobody says otherwise — `decks.game_key`'s own DDL default
/// (schema v18), so an omitted `gameKey` means here exactly what it means in SQL.
///
/// `DECK_GAMES[0]` **by index and not by spelling**, [`LIVE`]'s discipline: [`valid_game`]'s
/// refusal quotes that array, so a literal `"any"` here that drifted from it would leave the
/// column's own default unreachable through the command while everything still compiled.
///
/// **What the word *does* is TypeScript's**, exactly as [`AUTO_CATEGORY`]'s is. Rust stores
/// which platform the reader named and answers which platforms each format is playable on
/// (`format_specs.games`); narrowing one list by the other is a conclusion and lives in
/// `src/features/decks/useFormatSpecs.ts`.
pub const DEFAULT_GAME: &str = crate::schema::DECK_GAMES[0];

/// The `app_meta` key holding the format the last created deck was made in — what the New deck
/// dialog opens on, so a reader who builds Pioneer decks stops re-picking Pioneer.
///
/// `app_meta` is the *application's* key/value table (schema v6), deliberately not `sync_meta`
/// — a row in that one the sync did not write makes every later timing claim a fiction. **No
/// migration**: this is a key in a table that has existed since v6, and a preference that
/// needed a schema step would be a preference that could fail a launch. Nothing here is
/// dropped by `schema::swap_staging` either, so the row survives every refresh of the corpus.
///
/// The third key of its kind, after [`crate::marketplace::K_MARKETPLACE`] and
/// [`crate::card::K_PRINTING_GROUP_BY`] — and the one that is *not* written by a setter. It is
/// a side effect of [`create_deck`], because the preference being remembered is "what the
/// reader last did", not "what the reader chose in a settings panel".
pub const K_LAST_DECK_FORMAT: &str = "last_deck_format";

/// The `app_meta` key holding whether the deck editor's card search column was last left open.
///
/// The fourth key of its kind, after [`crate::marketplace::K_MARKETPLACE`],
/// [`crate::card::K_PRINTING_GROUP_BY`] and [`K_LAST_DECK_FORMAT`], and it takes that family's
/// whole argument with it: `app_meta` is the *application's* key/value table (schema v6),
/// deliberately not `sync_meta` — a row in that one the sync did not write makes every later
/// timing claim a fiction — and **no migration**, because a key in a table that has existed
/// since v6 is a preference that cannot fail a launch.
///
/// **Stored as `"1"`/`"0"` rather than as `"true"`/`"false"`.** `app_meta` is a text table and
/// every other key in it holds a word the app chose; a boolean has no word of its own, and the
/// two SQLite itself would write for one are these. Anything else in the row is
/// [`DEFAULT_DECK_SEARCH_OPEN`], by [`stored_deck_search_open`]'s argument.
pub const K_DECK_SEARCH_OPEN: &str = "deck_search_open";

/// Whether the deck editor's card search column is open when nobody has chosen.
///
/// `true`, and the reversal is issue #183's: the column used to open shut, on the argument that
/// a search is a thing you ask for. What that costs is paid on *every* deck opened — a reader
/// who searches while they build presses the same disclosure every time, and the app forgets
/// the press the moment the deck closes. Remembering the answer is what makes a default
/// defensible at all, so the two halves ship together: this is only the state of a database
/// nobody has expressed a preference in.
pub const DEFAULT_DECK_SEARCH_OPEN: bool = true;

/// Whether the search column was last left open, or [`DEFAULT_DECK_SEARCH_OPEN`].
///
/// Three cases collapse into the default, exactly as [`crate::card::stored_group_by`]'s do: no
/// row at all (a fresh install, and the common one), an unreadable row (`get_app_meta` swallows
/// the error), and a row holding something that is neither `"1"` nor `"0"` — what a hand-edit
/// or a differently-spelled build leaves behind. None of the three is worth failing over: the
/// worst a wrong answer costs is one press of a disclosure that is on screen either way.
pub fn stored_deck_search_open(conn: &Connection) -> bool {
    match crate::app_meta::get_app_meta(conn, K_DECK_SEARCH_OPEN).as_deref() {
        Some("1") => true,
        Some("0") => false,
        _ => DEFAULT_DECK_SEARCH_OPEN,
    }
}

/// Remember whether the search column is open.
///
/// No refusal to write, unlike [`crate::card::store_group_by`], and the difference is the type
/// rather than a softer rule: a `bool` has arrived narrowed and there is no third value a caller
/// could send for this one to reject.
pub fn store_deck_search_open(conn: &Connection, open: bool) -> Result<(), String> {
    crate::app_meta::set_app_meta(conn, K_DECK_SEARCH_OPEN, if open { "1" } else { "0" })
        .map_err(|e| format!("could not save the search column state: {e}"))
}

/// What [`add_card`] says when it is handed neither a category id nor a name to find or make
/// one by. The two are alternatives, not a pair — an explicit id is a drop onto a named
/// column, a name is the add path's "file it where this card belongs" (TypeScript's
/// `autoCategoryFor` computes the word) — but a card has to land *somewhere*, and
/// `deck_cards.category_id` is `NOT NULL`.
pub const NO_CATEGORY: &str = "A card needs a category to go in.";

/// What an adjustment says when the deck it names is not there.
pub const GONE: &str = "That deck is not there any more.";

/// `decks.default_category_id` when the deck files an unnamed add by **what the card does**
/// rather than into a pile the reader chose — schema v16's default, and the value every deck is
/// born with.
///
/// `0`, and it can never collide with a real pile because `deck_categories.id` is an
/// `INTEGER PRIMARY KEY`: SQLite's rowids start at 1. The frontend spells the same number
/// `AUTO_CATEGORY` (`src/features/decks/autoCategory.ts`), and the two are one vocabulary on
/// purpose — a sentinel that meant "unset" on one side of the IPC and "auto" on the other is
/// exactly how the editor once filed every quick add into a fresh deck's Commander pile.
///
/// **What Auto *does* is TypeScript's and stays there.** Rust holds the number; the rule that
/// turns a card into a pile name reads Oracle tags and is a conclusion.
pub const AUTO_CATEGORY: i64 = 0;

/// `decks.bracket` when the deck has **not** been told which Commander bracket it is and the
/// app's estimate stands — schema v26's default, and the value every deck is born with.
///
/// `0`, and the rest of the column is `1`–`5`, the five brackets the Commander Format Panel
/// publishes. A sentinel in a `NOT NULL` column rather than a nullable one, which is
/// [`AUTO_CATEGORY`]'s arrangement and [`AUTO_CATEGORY`]'s argument: [`DeckPatch`]'s convention
/// is that an absent field means "leave it", written as `coalesce(?n, column)` — so a NULL
/// column could not express "put it back to Auto" without a command of its own, which is the
/// price `decks.folder_id` pays through [`set_folder`]. The frontend spells the same number
/// `AUTO_BRACKET`, beside `AUTO_CATEGORY`, and the two are one vocabulary on purpose.
///
/// **What Auto *does* is TypeScript's and stays there**, [`AUTO_CATEGORY`]'s rule exactly. Rust
/// holds the number and the four facts the estimate reads (Game Changers, mass land denial,
/// extra turns, the combo tables); the rule that turns them into a bracket floor is a
/// conclusion and lives in `src/features/decks/validation/bracket.ts`.
///
/// **`0` is not "bracket 0" and the estimate never answers `5`.** The two are unrelated
/// absences that read alike: this sentinel says the reader has not answered, while the
/// estimator's refusal to reach 5 is a fact about the rules — brackets 4 and 5 have identical
/// *deck* restrictions and what separates them is an intent no card list shows. A deck can
/// still be *set* to 5 by hand, which is exactly why the column takes it and the estimate does
/// not produce it.
pub const AUTO_BRACKET: i64 = 0;

/// The highest bracket the Commander Format Panel publishes, and the top of what
/// [`valid_bracket`] accepts. `5` is cEDH.
const MAX_BRACKET: i64 = 5;

/// What [`update_deck`] says when it is handed a number that is not a bracket.
///
/// A sentence rather than a `CHECK constraint failed`, which is the discipline every refusal in
/// this file follows: the column carries no CHECK — **not because `ALTER TABLE … ADD COLUMN`
/// cannot add one**, which is false and which v19's `deck_cards.finish` disproves — but because
/// a command parameter reaches it, and a refusal in Rust can name the legal answers where a
/// constraint failure names only the constraint. [`valid_game`]'s arrangement one column along.
///
/// The whole vocabulary is in the sentence rather than the offending number, because the reader
/// arrives here through a picker that offers six choices: what they need is the list, not their
/// own input read back.
pub const BAD_BRACKET: &str =
    "A deck's bracket is 1 to 5, or 0 for Auto — where the app estimates it from the cards.";

/// A bracket [`decks.bracket`](DeckRow::bracket) may hold: [`AUTO_BRACKET`] or `1`–`5`.
///
/// **Rust's fence in place of a CHECK the DDL deliberately does not carry** — see
/// [`BAD_BRACKET`] for why that is a choice rather than a limitation. [`valid_game`]'s shape,
/// with one difference: a blank is not a case here, because this arrives as a number and
/// `DeckPatch`'s absent-means-leave-it is what an unsaid bracket already looks like.
fn valid_bracket(bracket: i64) -> Result<i64, String> {
    (AUTO_BRACKET..=MAX_BRACKET)
        .contains(&bracket)
        .then_some(bracket)
        .ok_or_else(|| BAD_BRACKET.to_owned())
}

/// `decks.cover_kind` when the deck shows a card's art crop — the DDL's own default, and what
/// [`update_deck`] puts back the moment a `coverCardId` arrives.
const COVER_CARD_ART: &str = "card_art";

/// `decks.cover_kind`'s **retired** word, and the reason it is still spelled here.
///
/// It meant "the deck shows the file the reader picked, at `<data dir>/covers/<id>.webp`".
/// Custom covers went on 2026-08-31 — a cover is [`DeckRow::cover_card_id`]'s art crop and
/// nothing else — so **nothing in this crate writes it any more**. Three things keep it a
/// constant rather than a deleted line:
///
/// * The column's `CHECK (cover_kind IN ('card_art','custom'))` still allows it, because the
///   column is retired in two phases and the DDL is phase two.
/// * `cover_kind` is a **synced** field (`sync_engine::capture`'s `decks` `Spec`), so a device
///   that has not taken this rung yet can still push a `custom` row onto this one. The read
///   side has to mean something when that lands, which is what [`cover_value`] is for.
/// * [`update_deck`] writes [`COVER_CARD_ART`] over it the moment a card is picked, which is
///   what repairs such a row locally.
const COVER_CUSTOM: &str = "custom";

/// What [`swap_printing`] says when it is asked to change a printing to itself. The pane
/// hides the action on the row the deck already uses, so reaching this is a double-click or
/// a list that went stale — either way there is nothing to write.
pub const SAME_PRINTING: &str = "That is already this printing.";

/// What [`swap_printing`] says when the printing it was pointed at is not in `cards`.
///
/// Deliberately **not** [`printing_of`]'s sentence: the printing was clicked out of a live
/// printings list a moment ago, so "no card with that id" is not news to the user — the news
/// is that `cards` was dropped and rebuilt underneath the open pane, which is the one thing
/// that can make a printing they are looking at stop existing (see CLAUDE.md's swap rule).
const PRINTING_GONE: &str = "That printing is not in the card database any more — a sync \
     replaced it while the card was open. Reopen the card for the printings it has now.";

/// What [`set_card_finish`] says when it is asked to change a finish to itself. The menu greys
/// the finish the row already is, so reaching this is a double-press or a menu that went stale
/// — either way there is nothing to write. [`SAME_PRINTING`]'s shape, for its reason.
pub const SAME_FINISH: &str = "That is already this finish.";

/// What [`set_card_finish`] says when the printing is not sold in the finish it was pointed at.
///
/// Read off `cards.finishes`, so it is also what a printing that has **left** the corpus
/// answers: the list of finishes went with the card, and "this printing is not sold in foil" is
/// the honest thing to say about a printing the database no longer has. Deliberately not
/// [`PRINTING_GONE`], which is about a printing the reader can see on screen and is a different
/// piece of news.
pub const FINISH_NOT_SOLD: &str = "That printing is not sold in that finish.";

/// The one place `'nonfoil'` becomes `None`.
///
/// **`None` is the regular copy and `'nonfoil'` is never stored.** Two spellings of one thing
/// would be two rows on [`crate::schema::DECK_CARD_GRAIN`] that draw identically on screen and
/// sum apart — the worst shape a bug in this table can have. `deck_cards.finish`'s CHECK is the
/// fence; this is the enforcement, and it is one function rather than a rule each command
/// remembers.
///
/// **An unrecognised word is refused rather than dropped.** A caller sending one has a bug, and
/// quietly filing its card as the regular copy would hide it. That is the opposite of the rule
/// TypeScript's `finishLabel` follows when *displaying* a stored value — where printing what the
/// reader's own data says is the honest answer — and the difference is that this is an input
/// fence rather than a render.
pub fn normalise_finish(raw: Option<&str>) -> Result<Option<String>, String> {
    match raw {
        None | Some("nonfoil") => Ok(None),
        Some(f) if crate::schema::FINISHES.contains(&f) => Ok(Some(f.to_owned())),
        Some(other) => Err(format!("`{other}` is not a finish this app knows.")),
    }
}

/// One new deck, as the "New deck" dialog sends it — **a whole configured deck, in one INSERT**.
///
/// Every deck-level field the settings dialog can edit is here, because the alternative is
/// create-then-patch-then-file: three transactions, a deck that exists in a state the user did
/// not ask for between each pair of them, and a half-configured row to unwind by hand when the
/// second one fails. That is the trap [`crate::import::commit_import`] exists to avoid on
/// the card side, and it is why this struct is wide rather than the three fields it was.
///
/// Two things it deliberately cannot say:
///
/// * **`cover_kind`.** It keeps its DDL default, [`COVER_CARD_ART`], whatever
///   [`Self::cover_card_id`] holds — and since custom covers went on 2026-08-31 that is the
///   only word anything writes, so there is nothing for this struct to say. It is still absent
///   rather than present-and-fixed, because a create that named the column would be a create
///   that could be asked for the other word.
/// * **Anything about cards.** A deck is born empty and with its four predefined categories;
///   [`add_card`] and [`crate::import::commit_import`] are what fill it.
///
/// A create leaves **one** history row however many of these fields it carries — see
/// [`create_deck`].
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckInput {
    pub name: String,
    pub format_key: String,
    /// Which platform the deck is for, or [`DEFAULT_GAME`] for none in particular.
    ///
    /// Absent is blank is `any`, resolved by [`valid_game`] — so a caller written before this
    /// field existed makes exactly the deck it used to. A `String` rather than an `Option`
    /// for [`Self::format_key`]'s reason: the column is `NOT NULL` with a default, and the
    /// empty string is already the way this struct says "you decide".
    ///
    /// **The deck's format is not checked against it, here or anywhere.** A Modern deck may
    /// say Arena. The pair is the reader's, the game narrows a *picker* rather than a deck,
    /// and a create that refused the combination would be refusing a deck over a filter.
    pub game_key: String,
    /// The one-line blurb the gallery tile shows.
    pub description: Option<String>,
    /// The long-form notes — the v8 column, and **not** [`Self::description`]. Two columns
    /// because they are two things: a caption and a notebook.
    pub notes: Option<String>,
    /// The card whose art crop the tile draws.
    ///
    /// A **soft** reference, like every card id in a user table, so nothing is checked here:
    /// `cards` is dropped and rebuilt on every sync, and a cover pointing at a printing that
    /// went away is a tile that falls back to a placeholder, not a deck that failed to be made.
    pub cover_card_id: Option<String>,
    /// Which folder to file the deck in, or `None` for the **root of the tree**.
    ///
    /// **This is the one field whose `None` does not mean what [`DeckPatch::folder_id`]'s
    /// means, and a reader who knows that rule will assume it applies here.** It does not. A
    /// patch writes `coalesce(?n, folder_id)`, which reads a bound NULL as "leave it" — which
    /// is why no patch can un-file a deck and why [`set_folder`] exists. This is an INSERT:
    /// there is no previous value for a null to leave alone, so an omitted folder is a deck at
    /// the top level, which is exactly what a reader who picked no folder meant.
    ///
    /// Fenced by the **real foreign key** rather than in words, unlike [`set_folder`]'s check:
    /// `decks.folder_id REFERENCES deck_folders(id)` is enforced (both are user tables, so the
    /// constraint is one the sync can never trip over), and a folder id that the dialog did not
    /// take out of the live folder list is a caller's bug rather than something a user typed.
    pub folder_id: Option<i64>,
    /// Whether the deck keeps a theory list beside its live one, from the moment it exists.
    ///
    /// **Sets the column and moves nothing**, which is the half that differs from
    /// [`DeckPatch::theory_enabled`]: that one runs
    /// [`crate::deck_theory::move_live_into_theory`] as it flips off → on, making the deck the
    /// reader already has into the plan and leaving the live list empty. A deck one statement
    /// old has no live list to move, so the two routes differ in what they *do* and agree
    /// exactly on what a new deck ends up with. `deck_theory`'s half is untouched and still runs
    /// on the patch route.
    ///
    /// Absent is `false` — resolved in Rust rather than by a `coalesce`; see [`create_deck`].
    pub theory_enabled: Option<bool>,
}

/// An edit to one deck. Every field is optional: absent means "leave it".
///
/// **Absent is the only way to say "leave it", so `null` cannot say "clear it".** Every column
/// below is written with `coalesce(?n, column)`, which reads a bound NULL as "unchanged" — so
/// there is no patch that files a deck back at the root of the folder tree, and none that
/// clears a cover or a description either. That is the shape this struct has had since v5 and
/// [`DeckPatch::folder_id`] joins it rather than inventing a second convention; un-filing a
/// deck wants a double-`Option` (absent versus null) across the whole struct, which is a
/// change to make once and deliberately, not as a side effect of adding a column.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckPatch {
    pub name: Option<String>,
    pub format_key: Option<String>,
    /// Which platform the deck is for — one of [`crate::schema::DECK_GAMES`], `any` included.
    ///
    /// **`any` is a value like every other and is why this column is not nullable**, which is
    /// [`Self::default_category_id`]'s argument exactly: absent still means "leave it", and a
    /// NULL would have been a second spelling of a word the reader can pick, unreachable
    /// through the `coalesce(?n, column)` every field here is written with.
    ///
    /// **Independent of [`Self::format_key`], in both directions.** Setting the game does not
    /// change the format and setting the format does not change the game; all the game does is
    /// narrow which formats a picker offers, which is a display decision and TypeScript's.
    pub game_key: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    pub archived: Option<bool>,
    /// Which folder the deck is filed in. `decks.folder_id` is `ON DELETE SET NULL`, so a
    /// folder the user deletes surfaces its decks at the root rather than taking them with it.
    ///
    /// **Un-filing is [`set_folder`]'s job, not this field's**, and no patch field could do it:
    /// by the rule above, a `null` here means "leave it". A reader looking for the way to put a
    /// deck back at the root of the tree wants that command.
    pub folder_id: Option<i64>,
    /// The deck's long-form notes — the v8 column, and **not** [`Self::description`], which is
    /// the one-line blurb the gallery tile shows. Two columns because they are two things: a
    /// caption and a notebook.
    ///
    /// **Neither column is "the create-time one" and neither is "the settings-only one."** This
    /// line used to split them that way — it said `description` was what the "New deck" dialog
    /// fills — and that stopped being a useful distinction the moment [`DeckInput`] grew to
    /// carry both: the two dialogs now render one form, so every deck-level field is reachable
    /// from whichever of them the user is in. What tells these two apart is what they hold.
    pub notes: Option<String>,
    /// Whether this deck keeps a theory list beside its live one.
    ///
    /// **Switching it on MOVES the live list into theory when there is nothing in it**, in this
    /// same transaction: the deck the reader has built is the plan, and what is sleeved up
    /// starts empty and fills as they acquire cards. Switching it off **keeps every row**: it
    /// hides a switch, it does not delete a list. Both halves live in [`crate::deck_theory`].
    pub theory_enabled: Option<bool>,
    /// Whether this deck files its variable-cost cards under a heading of their own.
    ///
    /// **Storage only, on this side.** Rust records the switch; what an X group *is* — which
    /// cards fall into it, what it is called, where it sorts against the type piles — is
    /// grouping logic and lives in TypeScript with the rest of it, for the boundary the crate
    /// root states. A card carrying an `{X}` is a fact (`cards.mana_cost`, and
    /// [`crate::filters::VARIABLE_COST_LIKE`] is how every SQL reader asks for it); which pile
    /// it belongs in is a conclusion.
    ///
    /// Per deck rather than per user, like [`Self::theory_enabled`]: it is a statement about how
    /// *this* list is read, so two decks may disagree and a duplicate must not.
    pub separate_x_group: Option<bool>,
    /// Which of this deck's categories an add that names none lands in — the editor's "Add to"
    /// answer, asked in the deck's settings.
    ///
    /// **`0` is `Auto` and is a value like any other**, which is why this is an `Option<i64>`
    /// over a `NOT NULL` column rather than a nullable one: absent still means "leave it", and
    /// `Some(0)` means "let each card's own text decide". A nullable column would have needed a
    /// command of its own to say that — `Self::folder_id`'s problem exactly, and [`set_folder`]
    /// is the price it pays.
    ///
    /// **Storage only, on this side**, [`Self::separate_x_group`]'s rule. *Which* pile Auto
    /// picks is `src/features/decks/autoCategory.ts` — a card's Oracle tags read as a
    /// conclusion — and Rust neither knows nor may learn it. What Rust does own is the fence:
    /// a non-zero id here must name a category **of this deck** ([`category_of_deck`]), because
    /// nothing in the DDL says so.
    pub default_category_id: Option<i64>,
    /// Which Commander bracket the reader says this deck is — schema v26.
    ///
    /// **Absent means "leave it" and `Some(0)` means "back to Auto"**, which is
    /// [`Self::default_category_id`]'s arrangement and the reason [`AUTO_BRACKET`] is a
    /// sentinel rather than a NULL: the `coalesce(?n, column)` every field here is written with
    /// reads a bound NULL as unchanged, so a nullable column could not spell the way back.
    ///
    /// Refused outside `0..=5` by name ([`BAD_BRACKET`]) rather than by a CHECK, because this
    /// is the one v26 column a command parameter reaches.
    ///
    /// **Storage only, on this side**, [`Self::separate_x_group`]'s rule. What a bracket
    /// *means* — which cards raise the estimate, whether the reader's answer sits below the
    /// floor the deck's contents imply — is domain logic and TypeScript's. Rust records the
    /// number and concludes nothing from it.
    pub bracket: Option<i64>,
}

/// Where the reader was last looking at one deck — the editor's own tab, grouping and sort.
///
/// Every field optional and absent means "leave it", [`DeckPatch`]'s convention and written the
/// same way (`coalesce(?n, column)`), so the editor can send the one control the reader touched.
///
/// Separate from [`DeckPatch`] rather than three more fields on it, because they are answers to
/// different questions and [`set_view_state`] is not an edit: it moves no `updated_at`, records
/// no history and reallocates nothing. Folding them in would put "which tab is open" one
/// forgotten `if` away from filling the history drawer and reordering the gallery.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckViewState {
    /// One of [`crate::schema::DECK_VARIANTS`], refused by name otherwise.
    pub variant: Option<String>,
    /// The editor's grouping mode, **stored verbatim** — see [`DeckRow::last_group_by`].
    pub group_by: Option<String>,
    /// The editor's sort, **stored verbatim** — see [`DeckRow::last_sort_by`].
    pub sort_by: Option<String>,
}

/// One deck as the gallery shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRow {
    pub id: i64,
    pub name: String,
    pub format_key: String,
    /// From `format_specs`, so the gallery never re-derives a display name.
    pub format_name: Option<String>,
    /// Which platform the deck is for — one of [`crate::schema::DECK_GAMES`], and `any` on
    /// every deck that predates schema v18 or has never been asked.
    ///
    /// **No `game_name` beside it, unlike [`Self::format_name`]**, and the asymmetry is the
    /// honest one: a format's display name is a *seeded cell* the gallery would otherwise have
    /// to re-derive, while a game's is four words in a picker's own list. There is no table to
    /// read one from and nothing for two sources to disagree about.
    pub game_key: String,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    /// `card_art`, on every row this app writes — see [`COVER_CUSTOM`] for the word that is
    /// retired and why it is still spellable.
    ///
    /// It decided which of two pictures a tile drew while there were two. There is one:
    /// [`Self::cover_card_id`]'s art crop. **The field stays on the wire** because the column
    /// is retired in two phases and this is phase one, and because a `custom` row can still
    /// arrive over sync from a device that has not taken this rung — a tile that reads this at
    /// all must treat it as "draw the card art" either way.
    pub cover_kind: String,
    /// Scryfall image policy: an `art` crop lacks the printed frame, so wherever the
    /// gallery shows one it must credit the artist — read here so the tile can.
    pub cover_artist: Option<String>,
    pub archived: bool,
    /// `live` copies in **active** categories of kind `main`, `commander` or `maybe` — what "a
    /// 60-card deck" means in a caption, and **the same cards the validation engine sizes a
    /// deck by** (`SIZE_KINDS` in `engine.ts`). One definition, because a tile that says 101
    /// beside a panel that says "exactly 100 incl cmdr; you have 100" is two answers to one
    /// question. The kind list here and that constant are the same three words, and a change to
    /// one is a change to both.
    ///
    /// **The switch decides whether a pile counts at all; the kind decides only whether it is
    /// played *beside* the deck or *in* it — and only `side` and `companion` are beside it.**
    /// So the sideboard is out (CR 100.4a) and the companion is out (EDH calls one "effectively
    /// a 101st card", which is exactly the card this must not add), and everything else that is
    /// switched on is in.
    ///
    /// That is why `maybe` is on the list, which reads odd until the alternative is written
    /// out: leaving it off made an *active* Maybeboard part of the format's card pool and part
    /// of the binder's reservations but not part of the deck's size — so a second Sol Ring in
    /// one was a singleton error reported under a size figure that still read 100. Kind `maybe`
    /// now exists for exactly one reason, to name the predefined Maybeboard and seed it
    /// inactive, and that is honest: being switched off is the whole of what the Maybeboard is.
    pub card_count: i64,
    pub updated_at: i64,
    /// Which folder the deck is filed in, or `None` for the root of the tree.
    pub folder_id: Option<i64>,
    /// The deck's long-form notes — the v8 column, not [`Self::description`].
    pub notes: Option<String>,
    /// Whether this deck keeps a theory list beside its live one.
    ///
    /// Read here as well as written through [`DeckPatch`] because a switch the app can set and
    /// never see is a switch nothing can draw: the editor's Live/Theory control is this
    /// boolean, and without it on the row every reader would have to guess from whether one of
    /// the two lists happens to be empty — which, now that switching it on **moves** the live
    /// list across, is a guess that would answer backwards on every deck that has just been
    /// switched on.
    pub theory_enabled: bool,
    /// Whether this deck files its variable-cost cards under a heading of their own — schema
    /// v13.
    ///
    /// Read here as well as written through [`DeckPatch`], for [`Self::theory_enabled`]'s
    /// reason: a switch the app can set and never see is a switch nothing can draw. The
    /// grouping it controls happens in TypeScript — this is the stored answer, not the rule.
    ///
    /// **Not a fourth `last_*` field, though it arrived beside them.** Those three are how the
    /// reader was *looking* at the deck a moment ago and are rewritten by looking; this one is
    /// an answer about the deck that a copy of it inherits. `duplicate_deck` carries this and
    /// resets nothing, which is the difference stated as code.
    pub separate_x_group: bool,
    /// Which of this deck's categories an add that names none lands in — schema v16, and `0`
    /// for **Auto**, where the card's own text decides.
    ///
    /// Read here as well as written through [`DeckPatch`], for [`Self::theory_enabled`]'s
    /// reason: a setting the app can write and never see is a setting nothing can draw. This is
    /// the one that setting *is* — the editor's docked search panel and its quick-add field both
    /// file by it, and the deck settings dialog is where it is chosen.
    ///
    /// **Not a fourth `last_*` field**, [`Self::separate_x_group`]'s distinction: it is not how
    /// the reader was looking at the deck a moment ago, it is an answer about the deck that a
    /// copy of it inherits — remapped onto the copy's own categories by [`duplicate_deck`],
    /// because the copy's piles are new rows with new ids.
    pub default_category_id: i64,
    /// Which of the two lists the reader last had open, one of
    /// [`crate::schema::DECK_VARIANTS`] — schema v12.
    ///
    /// **Stored per deck rather than per session**, because that is the shape of the question:
    /// a reader with a built deck and a deck they are designing wants Live on one and Theory on
    /// the other, and one app-wide setting would make every visit to the second deck a
    /// correction. [`crate::deck_theory::move_live_into_theory`] writes it too — after the move
    /// the live tab is empty and the reader's deck is one tab across.
    ///
    /// The column carries **no CHECK** (`ALTER TABLE ADD COLUMN` cannot add one), so
    /// [`set_view_state`] is the fence and refuses anything else by name.
    pub last_variant: String,
    /// How the editor was grouping the deck when the reader last left it — schema v12.
    ///
    /// **A TypeScript vocabulary Rust deliberately does not know** (`category | manaValue |
    /// type`, `DeckEditor`'s own). Grouping a deck is domain logic and domain logic is
    /// TypeScript's, so this is stored verbatim as a fact about what the reader chose and
    /// narrowed on read, with a fallback, by the side that owns the words. A mode renamed there
    /// costs one reader one remembered choice; the alternative costs a migration. Rust refuses
    /// only a blank, which is not an answer.
    pub last_group_by: String,
    /// How the editor was sorting the deck when the reader last left it — schema v12, and
    /// [`Self::last_group_by`]'s rule exactly (`alphabetical | manaCost | price | type`).
    pub last_sort_by: String,
    /// Which Commander bracket the reader says this deck is — schema v26, and
    /// [`AUTO_BRACKET`] (`0`) for **Auto**, where the app's estimate stands. `1`–`5` is their
    /// own answer.
    ///
    /// Read here as well as written through [`DeckPatch`], for [`Self::theory_enabled`]'s
    /// reason: a setting the app can write and never see is a setting nothing can draw. The
    /// deck header's bracket readout is the surface — it prints `Bracket 3` for a set answer
    /// and `Bracket ~3` for an estimate, and telling those two apart is exactly this number
    /// being on the row.
    ///
    /// **Not a fourth `last_*` field**, [`Self::separate_x_group`]'s distinction: it is not how
    /// the reader was looking at the deck a moment ago, it is an answer *about the deck* — so
    /// [`duplicate_deck`] carries it across, where it resets the three `last_*` columns.
    ///
    /// **Rust neither computes it nor checks it against the cards.** The estimate, the floor
    /// the deck's contents imply and the warning when a set bracket sits below that floor are
    /// all conclusions and all TypeScript's; this is the stored fact and the four signals the
    /// rule reads are supplied separately.
    pub bracket: i64,
    /// **The cover printing's picture, not the deck's** — the row [`Self::cover_card_id`] names,
    /// read off the same `LEFT JOIN cards` [`Self::cover_artist`] comes from. A deck is not a
    /// card and has no images of its own; this is the one field on this struct that describes a
    /// *different* row, which is why it is worth saying twice.
    ///
    /// The key a tile wants is [`crate::image_uri::ART_VARIANT`]. A deck's cover is a crop
    /// rather than a card face, and it is the only cover mechanism there is since custom covers
    /// went — so `display` is here because [`crate::image_uri::LIST_VARIANTS`] emits the pair
    /// and not because anything on a gallery reads it.
    ///
    /// **Why it is on the wire at all**, [`crate::search::CardSummary::image_uris`]' argument
    /// in full: `mtgimg://` is a Tauri custom protocol and wasm cannot register a URL scheme
    /// with a browser, so on web and on Android the URL travels with the row or the tile draws
    /// nothing. That is what it was doing — every deck cover in a browser was a blank frame the
    /// moment PR #327 made the card crop the only cover. On desktop this is ignored, because
    /// `src/lib/images.ts`'s `cardArtSrc` takes the local cache.
    ///
    /// `None` for a deck with no cover, for a cover whose printing has left `cards`, and for a
    /// printing with no fetchable image — three states the tile draws identically, because from
    /// the reader's side they are one: nothing to show yet. The first two heal on the next sync,
    /// which is [`Self::cover_artist`]'s own note.
    pub image_uris: Option<BTreeMap<String, String>>,
}

/// A name a gallery can show. A deck with no name is a nameless tile, and `decks.name` has
/// no CHECK to catch one — this is the whole of that constraint.
fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| "A deck needs a name.".to_owned())
}

/// A format key `format_specs` actually holds.
///
/// Validated **here rather than by a foreign key**, on purpose: `format_specs` is seeded
/// with `INSERT OR REPLACE` and every future migration that corrects a cell re-runs that
/// seed, which a REFERENCES clause on a live `decks` row would turn into a migration that
/// can fail in the field. Blank is the DDL's own `DEFAULT 'casual'` — an omitted format is
/// not a wrong one.
fn valid_format<'a>(conn: &Connection, key: &'a str) -> Result<&'a str, String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(DEFAULT_FORMAT);
    }
    conn.query_row(
        "SELECT 1 FROM format_specs WHERE key = ?1",
        params![key],
        |_| Ok(()),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|()| key)
    .ok_or_else(|| {
        format!("`{key}` is not a format this app knows. Pick one from the format list.")
    })
}

/// A platform `decks.game_key` may hold — one of [`crate::schema::DECK_GAMES`].
///
/// **Rust's fence in place of a CHECK the DDL cannot carry**, `decks.last_variant`'s situation
/// at v12: the column arrives by `ALTER TABLE … ADD COLUMN`, and SQLite cannot add a constraint
/// that way. It is owed here and not on `format_specs.games` because this is the one of the two
/// v18 columns a command parameter reaches.
///
/// Blank is [`DEFAULT_GAME`] — the DDL's own default, so an omitted game is not a wrong one,
/// which is [`valid_format`]'s rule applied to the column beside it. Unlike that one this needs
/// no query: the vocabulary is a constant rather than a seeded table.
fn valid_game(game: &str) -> Result<&str, String> {
    let game = game.trim();
    if game.is_empty() {
        return Ok(DEFAULT_GAME);
    }
    crate::schema::DECK_GAMES
        .contains(&game)
        .then_some(game)
        .ok_or_else(|| {
            format!(
                "`{game}` is not a game this app knows. Use one of: {}.",
                crate::schema::DECK_GAMES.join(", ")
            )
        })
}

/// `set_code`, `collector_number`, `lang`, `name` — what a zone write copies onto its row.
pub(crate) type Printing = (String, String, String, String);

/// The printing and the name, as the deck row will remember them.
///
/// The name is what `collection::printing_of` does not read and the wishlist does: a
/// collection row is a thing the user can hold, but a deck list is *read*, and a line that
/// can only say `e7f8…` once the id stops resolving is not a deck list.
///
/// `pub(crate)`, not private, for [`touch_deck`]'s reason: [`crate::import::commit_import`]
/// denormalizes exactly these four columns onto exactly the same table, and a second copy of
/// this query would be a second place for an imported row and an added row to disagree about
/// what a deck card remembers.
pub(crate) fn printing_of(conn: &Connection, card_id: &str) -> Result<Printing, String> {
    printing_row(conn, card_id)?
        .ok_or_else(|| format!("no card with the id `{card_id}` is in the card database"))
}

/// The same read, with "not there" left to the caller — one SQL statement, two sentences.
/// [`add_card`] is told an id it was handed does not resolve; [`swap_printing`] knows more
/// than that (see [`PRINTING_GONE`]) and says it.
fn printing_row(conn: &Connection, card_id: &str) -> Result<Option<Printing>, String> {
    conn.query_row(
        "SELECT set_code, collector_number, lang, name FROM cards WHERE id = ?1",
        params![card_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Which oracle card a printing is of — `None` when the id is not in `cards`, **and equally
/// when the row it finds has no `oracle_id`**.
///
/// One answer for both, because they are the same answer to the only question asked here:
/// *can these two printings be compared?* `cards.oracle_id` is NULLABLE (no live row is null,
/// all 116 k of them, but the column is), and a null is as uncomparable as a missing row —
/// folding it into the SQL rather than into a `match` is what keeps a caller from reading
/// `Some(null)` as an oracle two printings could share.
fn oracle_of(conn: &Connection, card_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT oracle_id FROM cards WHERE id = ?1 AND oracle_id IS NOT NULL",
        params![card_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// What [`swap_printing`] says when the two ids are printings of *different cards*.
///
/// Names both, because which two were paired is the whole question — and it names the one in
/// the deck as **the deck lists it** and the target as **`cards` has it now**, which is what
/// the reader is looking at on each side of the press.
fn not_the_same_card(from: &str, to: &str) -> String {
    format!(
        "`{to}` is not another printing of `{from}`. Swapping a printing changes which \
         printing of a card this deck plays, never which card it plays."
    )
}

/// Move the deck's `updated_at` — and, in the same statement, learn whether the deck is
/// there at all.
///
/// Every zone write opens with this, which buys two things for one UPDATE. The gallery
/// sorts by this column, so a write that left it alone would be an edit that does not
/// surface; and a stale deck id — a gallery that has not refreshed since another view
/// deleted the deck — is answered with [`GONE`] rather than with a foreign-key error, one
/// statement before there is an orphan row to worry about.
///
/// `pub(crate)`, not private: [`crate::deck_meta`]'s category, label and folder writes open
/// with it too — a category rename is exactly as much an edit the gallery should surface as
/// a card add is, and duplicating the UPDATE there would be a second place to keep this in
/// step with [`GONE`].
pub(crate) fn touch_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE decks SET updated_at = unixepoch() WHERE id = ?1",
            params![deck_id],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0).then_some(()).ok_or_else(|| GONE.to_owned())
}

/// What a card write says when the row it was asked to adjust is not in that category.
///
/// Takes the category's **name**, not its id: a number a user never chose says nothing, and
/// every caller has the name already — [`category_of_deck`] hands it back as the by-product
/// of the fence they all run first.
fn card_gone(category: &str) -> String {
    format!("That card is not in this deck's {category} category any more.")
}

/// Check that a category id names a category **of this deck**, and answer its name.
///
/// The fence every card command opens with, and it is not decoration: nothing in the DDL
/// stops `deck_cards.category_id` pointing at a category of a *different* deck — the FK only
/// requires the row to exist — so this is where "a card of deck A cannot be filed under a
/// category of deck B" actually lives. [`crate::deck_meta::delete_category`]'s move target and
/// `set_card_label`'s label id draw the same two-sentence distinction, and for the same reason:
/// "gone" and "not yours" are different things to tell a stale editor.
///
/// Returning the name rather than `()` is what lets [`card_gone`] name the category the reader
/// is looking at without a second query.
fn category_of_deck(conn: &Connection, deck_id: i64, category_id: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT deck_id, name FROM deck_categories WHERE id = ?1",
        params![category_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| crate::deck_meta::CATEGORY_GONE.to_owned())
    .and_then(|(owner, name)| {
        (owner == deck_id)
            .then_some(name)
            .ok_or_else(|| crate::deck_meta::CATEGORY_WRONG_DECK.to_owned())
    })
}

/// What a category is called, or `None` for [`AUTO_CATEGORY`] and for a pile that is not there.
///
/// [`category_of_deck`]'s quiet counterpart, and deliberately **not** a fence: this answers a
/// question about the past — what the deck's default pile *was* before an edit replaced it — so
/// the two ways of having no name are one answer here. `0` is Auto and never named a pile; an id
/// with no row behind it is a pile deleted since, which the history should record as "no pile"
/// rather than refuse an unrelated write over.
fn category_name(conn: &Connection, category_id: i64) -> Result<Option<String>, String> {
    if category_id == AUTO_CATEGORY {
        return Ok(None);
    }
    conn.query_row(
        "SELECT name FROM deck_categories WHERE id = ?1",
        params![category_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every column of a [`DeckRow`], from the one query shape the list and the single read
/// share. Both LEFT JOINs are load-bearing: a vanished cover printing or a format key the
/// specs no longer carry must never hide a deck from its owner.
///
/// The subquery is [`DeckRow::card_count`]'s definition, and it is the engine's `SIZE_KINDS`
/// (`main`, `commander`, `maybe`) verbatim — see that field's doc for why `maybe` is on the
/// list. Its `JOIN deck_categories` is an *inner* join, unlike the two above it, because
/// `deck_cards.category_id` is `NOT NULL` with an enforced foreign key: a card with no category
/// is a row the schema cannot hold.
///
/// `'live'` is spelled out rather than interpolated from [`LIVE`] because there is nothing to
/// interpolate with at that point;
/// `the_gallery_count_reads_only_live_rows_in_active_categories` is what keeps the literal
/// honest, and `an_active_maybeboard_is_part_of_the_deck_and_an_inactive_one_is_not` is what
/// keeps the kind list in step with `SIZE_KINDS`.
///
/// **A `LazyLock<String>` rather than a `const`, and the `LEFT JOIN cards` is why.** That join
/// was here for `c.artist` alone; [`crate::image_uri::front_face_selects`] reads the same row
/// for the cover printing's picture, and the variants it emits come from
/// [`crate::image_uri::LIST_VARIANTS`] rather than from anything spellable in a `const`. The
/// `format!` is spent once per process — `OWNED_SPARE_SQL`'s arrangement one file over, for the
/// same reason: a live read has to mean whatever the constant means today.
static DECK_SELECT: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "SELECT d.id, d.name, d.format_key, fs.display_name, d.description,
            d.cover_card_id, d.cover_kind, c.artist, d.archived,
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                        JOIN deck_categories cat ON cat.id = dc.category_id
                       WHERE dc.deck_id = d.id
                         AND dc.variant = 'live'
                         AND cat.is_active = 1
                         AND cat.kind IN ('main','commander','maybe')), 0),
            d.updated_at, d.folder_id, d.notes, d.theory_enabled,
            d.last_variant, d.last_group_by, d.last_sort_by, d.separate_x_group,
            d.default_category_id, d.game_key, d.bracket,
            {images}
       FROM decks d
       LEFT JOIN format_specs fs ON fs.key = d.format_key
       LEFT JOIN cards c ON c.id = d.cover_card_id",
        images = crate::image_uri::front_face_selects("c").join(", ")
    )
});

fn deck_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckRow> {
    /// Where `DECK_SELECT`'s image columns start — one past `d.bracket`, the last named
    /// column. Named rather than inlined for `deck_card_select`'s reason: the pairing
    /// arithmetic below is `front_face_map`'s and only the *offset* is this function's.
    const IMAGE_COL: usize = 21;
    Ok(DeckRow {
        id: r.get(0)?,
        name: r.get(1)?,
        format_key: r.get(2)?,
        format_name: r.get(3)?,
        description: r.get(4)?,
        cover_card_id: r.get(5)?,
        cover_kind: r.get(6)?,
        cover_artist: r.get(7)?,
        archived: r.get(8)?,
        card_count: r.get(9)?,
        updated_at: r.get(10)?,
        folder_id: r.get(11)?,
        notes: r.get(12)?,
        theory_enabled: r.get(13)?,
        last_variant: r.get(14)?,
        last_group_by: r.get(15)?,
        last_sort_by: r.get(16)?,
        // Positional, like every read above it — a column added anywhere but the **end** of
        // `DECK_SELECT`'s list shifts every index after it, silently, into a field of the same
        // SQLite type. New columns go last here for exactly that reason, and this one is the
        // proof: it read 15 on the branch that wrote it, where v12's three did not exist yet,
        // and reading 15 after the merge would have handed a `TEXT` variant to a `bool`.
        //
        // **Every index from here up moved down by one when schema v25 dropped `is_built`**,
        // which is the same rule read backwards and the reason a removal is as dangerous as an
        // addition: the column that was at 8 is gone, so leaving these numbers alone would have
        // handed `archived`'s `INTEGER` to `card_count` and walked the whole tail off the end.
        separate_x_group: r.get(17)?,
        // 18, at the end of the list, for the reason written on the line above it. This one is
        // the second proof of that rule: the branch that wrote it was cut from a head where
        // `separate_x_group` was the last column, and inserting it anywhere but here would have
        // handed an `INTEGER` category id to a `bool` with nothing going red.
        default_category_id: r.get(18)?,
        // 19, at the end of the list, for the reason written two comments up. Third proof of
        // that rule and the cheapest one to have got wrong: `game_key` is TEXT and so is
        // `last_variant` at 14, so a column inserted beside the format — where it *reads* like
        // it belongs — would have handed a deck's variant to its game and back, with both
        // fields still holding a plausible-looking string.
        game_key: r.get(19)?,
        // 20, at the end of the list, for the reason written three comments up — and the
        // fourth proof of that rule, this one from the other side of the trap. `bracket` is an
        // INTEGER and so are `archived` at 8, `card_count` at 9, `updated_at` at 10,
        // `folder_id` at 11, `theory_enabled` at 13, `separate_x_group` at 17 and
        // `default_category_id` at 18: a column inserted beside the deck's other *settings*,
        // where it reads like it belongs, would have handed a bracket to a bool and a pile id
        // to a bracket, with every field still holding a number SQLite is perfectly happy to
        // give back.
        bracket: r.get(20)?,
        // **From 21**, last of all, for the reason written four comments up — the
        // `crate::image_uri::FRONT_FACE_COLUMNS` expressions `front_face_selects` appended, in
        // the (top-level, face) pairs `front_face_map` folds back up, one pair per variant.
        //
        // This read carries a failure the twenty above it do not. Every one of those is caught
        // by a value of the wrong *kind* turning up in a field; here the pair is
        // (top-level, face) and `for_face` prefers the face, so a read one column out still
        // answers a perfectly real URL — the right picture from the wrong slot, or the crop
        // where the card belongs. No fixture carrying a single column can tell the two apart;
        // `image_uri`'s `meld` row, which disagrees with itself in both columns and for both
        // variants, is the shape that can.
        image_uris: crate::image_uri::front_face_map(|i| {
            r.get::<_, Option<String>>(IMAGE_COL + i)
        })?,
    })
}

/// One deck, or nothing. Every write that returns a `DeckRow` ends here, so the row the
/// caller gets back is the row the gallery would have read.
pub(crate) fn read_deck(conn: &Connection, id: i64) -> Result<Option<DeckRow>, String> {
    conn.query_row(
        &format!("{} WHERE d.id = ?1", *DECK_SELECT),
        params![id],
        deck_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// What a `collection_folders` row standing for a deck carries in its `kind` column —
/// [`crate::schema::COLLECTION_FOLDER_KINDS`]`[1]`, by index rather than by spelling so the
/// word here and the word the CHECK allows cannot drift.
const DECK_GROUP_KIND: &str = crate::schema::COLLECTION_FOLDER_KINDS[1];

/// And the holding area's kind, `[2]` — the single folder copies go to when they leave the
/// collection without leaving the database.
const REMOVED_GROUP_KIND: &str = crate::schema::COLLECTION_FOLDER_KINDS[2];

/// The collection group that stands for this deck, or `None`.
///
/// **`Option` rather than a refusal, even though every deck has one.** Schema v25 gave one to
/// every deck that existed and [`create_deck`] and [`duplicate_deck`] give one to every deck
/// made since, so the `None` arm is unreachable through the app — but the caller that needs to
/// ask here is [`delete_deck`], whose whole contract is that deleting something that is not
/// there is a success. A helper that raised there would turn a hand-edited database into a deck
/// the reader can never remove. Answering the fact and letting each caller conclude is the
/// crate's boundary read one module in: [`crate::collection_alloc::collection_to_deck`] takes
/// the same `None` and **refuses** it, in words, because a reader who ticked "put these copies
/// in this deck" must not have them filed at the root instead.
///
/// **`pub(crate)`, and the two copies of it are why.** `collection_alloc` had a private twin of
/// this query — same table, same column, one lookup written twice — carried from the PR that
/// added it. A helper duplicated across modules is a fix that has to be made twice or is made
/// once, so this is the one definition and that one is gone.
///
/// The `kind` fence is redundant against `CHECK ((kind = 'deck') = (deck_id IS NOT NULL))` and
/// is kept from the twin anyway: it costs nothing, and it says at the call site which of the
/// three folder kinds this row can be.
pub(crate) fn deck_group(conn: &Connection, deck_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM collection_folders WHERE deck_id = ?1 AND kind = ?2",
        params![deck_id, DECK_GROUP_KIND],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The one holding area `Recently removed`, or `None`.
///
/// **`Option` rather than a refusal, for [`deck_group`]'s reason and not quite its shape.**
/// Schema v25 creates exactly one and a partial unique index makes a second impossible, so
/// `None` is a database somebody has edited by hand. The two callers want opposite answers to
/// that: [`delete_deck`] falls back to the root, because a deck the reader can never delete is
/// worse than cards at the root, and [`release_group_copies`] refuses, because it is the bulk
/// form of [`crate::collection_alloc::deck_to_collection`] and that command refuses. Answering
/// the fact and letting each caller conclude is the crate's boundary read one module in.
fn removed_group(conn: &Connection) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM collection_folders WHERE kind = ?1",
        params![REMOVED_GROUP_KIND],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// What [`release_group_copies`] did.
///
/// Two facts and not one, because its two callers want different halves — and only one of them
/// wants either. [`release_live_copies`], which every bulk press goes through, is emptying a
/// scope rather than reporting on one and discards the whole struct: what those presses tell the
/// reader is the count of `deck_cards` they took, never the copies that moved, and the two
/// differ wherever the group holds fewer than the list claims.
/// [`crate::collection_alloc::deck_to_collection`] is the caller that reads it, and answers a
/// [`crate::collection_alloc::MoveOutcome`] whose `entry_id` is where the copies **landed**, so
/// the reader can be sent to look at them.
///
/// `landed` is `None` when nothing moved, and is the *last* row filed when several did — one
/// press can empty two group rows into the holding area, and the holding area is one folder, so
/// pointing at the last of them points at the pile.
pub(crate) struct Released {
    /// Copies that actually changed folder. `0` is a success — see [`release_group_copies`].
    pub moved: i64,
    /// The `collection_entries` row the last of them landed in, after any merge.
    pub landed: Option<i64>,
}

/// Give back the copies this deck's group holds for one card — up to `quantity` of them — by
/// filing them into `Recently removed`.
///
/// **This is the crate's one copy of that walk, and there were two.**
/// [`crate::collection_alloc::deck_to_collection`] spelled the same backing query and the same
/// greedy loop inline for the single-card cut, and this one was written for the presses that
/// take a whole pile out at once — where the `deck_cards` rows are going by a route of their own
/// and only the copies are left to place. Two implementations of one rule disagree the first
/// time either changes, and this rule decides where a reader's cards are: the cut now calls this
/// and adds the deck-card write and the history row, which is the whole of what it ever had
/// extra. **The bulk presses reach it through [`release_live_copies`]**, which is the same
/// argument one level up — the *loop* over the rows had grown three copies of its own.
/// Called inside the caller's transaction, like [`crate::deck_audit::record`] and for its
/// reason: a rolled-back clear must not have moved a card.
///
/// **The live list only, and the caller is what enforces it.** A theory row is a plan and a plan
/// holds no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so nothing in any folder
/// backs one; this function is never handed one and does not test for it. There are two callers
/// to enforce it and each already knows which list it is holding:
/// [`crate::collection_alloc::deck_to_collection`] refuses a theory row outright, and
/// [`release_live_copies`] — the bulk form, and now the only route the presses that empty a
/// whole pile or a whole list take — returns before it reads anything.
///
/// # It matches on the **oracle card**, not on the printing, and that is the fix for a stranding
///
/// The obvious query — this printing, this finish — is the one this function had, and it strands
/// copies. `deck_swap_printing` and `set_card_finish` rewrite a `deck_cards` row's identity and
/// touch no collection table, so after "Use this printing" the group still holds the *old*
/// printing's row: an exact match then finds nothing, the deck card goes away and the copies
/// stay filed under a deck that no longer lists them — invisible on the collection page, and
/// unavailable to every other deck. **It is not hypothetical for an upgraded reader either**:
/// the allocator schema v25 replaced matched candidates by oracle id, so the conversion
/// routinely files a printing the deck does not list.
///
/// So the arms are, in order: the **exact printing and finish** first, then any other row in
/// this group holding the same `cards.oracle_id`. That is [`owned_by_oracle`]'s rule — "a Bolt
/// is a Bolt", the behaviour this feature kept deliberately — read from the other end: a deck
/// that *counts* an Alpha Bolt toward an M10 line has to be able to give that copy back. The
/// ordering is what keeps the common case byte-for-byte what it was: where the group holds the
/// very printing the list names, that is the row that leaves.
///
/// **`LEFT JOIN cards`, so an orphan is still releasable.** `cards` is dropped and recreated on
/// every sync and a collection row's `card_id` is a soft reference; an INNER join would make a
/// row whose printing has left the corpus unreleasable — including by the exact match, which
/// needs no `cards` row at all. When the *deck's* card is the orphan the sub-select answers
/// NULL, the oracle arm is NULL rather than true, and the query degrades to exactly the exact
/// match it used to be.
///
/// **Rows are taken oldest first and there may be several**, [`crate::collection_alloc`]'s rule
/// verbatim: one printing can sit in two categories of one deck while the group holds a single
/// row for the grain, so the number here is the *pile's* claim on that row rather than the whole
/// of it. Clamped at what is actually there rather than refused, because the group and the list
/// can disagree — an import writes a list without moving copies — and refusing over a
/// disagreement this write did not cause would leave a pile the reader cannot clear.
///
/// **A deck card with no backing copies just goes away**, which is the answer
/// [issue #209](https://github.com/Msgaihede/mtg-grimoire/issues/209) could not find: a card
/// added from search is an intention to buy, the reader never owned it, and nothing lands on
/// their desk. A `moved` of `0` is that, and is not a failure.
pub(crate) fn release_group_copies(
    tx: &Connection,
    deck_id: i64,
    card_id: &str,
    finish: Option<&str>,
    quantity: i64,
) -> Result<Released, String> {
    let nothing = Released {
        moved: 0,
        landed: None,
    };
    if quantity <= 0 {
        return Ok(nothing);
    }
    // **A deck with no group holds nothing rather than refusing** — `deck_to_collection`'s own
    // asymmetry: only the other direction *needs* somewhere to put copies, and a reader must
    // always be able to empty a pile or cut a card.
    let Some(group) = deck_group(tx, deck_id)? else {
        return Ok(nothing);
    };
    // The deck row's `NULL` is the collection row's `'nonfoil'` — [`normalise_finish`]'s
    // translation, read the other way.
    let entry_finish = finish.unwrap_or(crate::schema::FINISHES[0]);
    let backing: Vec<(i64, i64)> = tx
        .prepare(
            "SELECT e.id, e.quantity
               FROM collection_entries e
               LEFT JOIN cards c ON c.id = e.card_id
              WHERE e.folder_id = ?1
                AND (e.card_id = ?2
                     OR c.oracle_id = (SELECT oracle_id FROM cards WHERE id = ?2))
              ORDER BY CASE WHEN e.card_id = ?2 AND e.finish = ?3 THEN 0
                            WHEN e.card_id = ?2 THEN 1
                            ELSE 2 END,
                       e.id",
        )
        .and_then(|mut s| {
            s.query_map(params![group, card_id, entry_finish], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;
    if backing.is_empty() {
        return Ok(nothing);
    }
    // Resolved only when there is something to file, so a hand-edited database missing the
    // folder still lets a pile of cards nobody owned be cleared.
    let removed =
        removed_group(tx)?.ok_or_else(|| crate::collection_alloc::NO_REMOVED_FOLDER.to_owned())?;
    let mut moved = 0i64;
    let mut landed = None;
    for (id, held) in backing {
        if moved == quantity {
            break;
        }
        let take = held.min(quantity - moved);
        landed = Some(crate::collection_folders::take_copies(
            tx,
            id,
            take,
            Some(removed),
        )?);
        moved += take;
    }
    Ok(Released { moved, landed })
}

/// Give back every copy this deck's group holds behind a whole set of `live` rows — one pile of
/// it, or the whole list.
///
/// **This is the bulk half of [`release_group_copies`], and it was written three times before it
/// was written once.** [`clear_category`] empties one pile, [`clear_variant`] empties a list,
/// [`crate::deck_meta::delete_category`]'s cascade arm takes a pile away with its category, and
/// each of them spelled out the same six lines: read `card_id`, `finish` and `quantity` from the
/// rows about to go, then call [`release_group_copies`] once per row. The fourth site is
/// [`crate::import::commit_import`]'s `replace` branch, and it is the one that *forgot* —
/// [issue #336](https://github.com/Msgaihede/mtg-grimoire/issues/336): the identical DELETE with
/// no release beside it, so importing over a live list left every copy the reader owns filed
/// under a deck with no row for it. A rule written down four times is a rule three of the copies
/// will not have, so the loop lives here now and the fourth site calls it like the other three.
///
/// **The `live` fence moved in here with it.** Every call site used to ask `variant == LIVE`
/// itself, which is a question each of them could get right and a fifth could forget; asking it
/// once, at the one place that would do the moving, is what makes forgetting it impossible. A
/// plan holds no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so nothing in any
/// folder backs a `theory` row — which is why `theory` is **a loop that never runs** rather than
/// a refusal. The refusal is right one card at a time, where a caller asked for a move and must
/// be told it cannot have one; here nothing was asked for, and there is simply nothing to give
/// back.
///
/// **`category_id` of `None` is the whole variant and `Some(id)` is one pile**, and that single
/// argument is the entire difference between the pile clear and the list clear. It is why one
/// helper covers both: the scope is the caller's business and the release is not.
///
/// **Read before the caller's DELETE and inside the caller's transaction**, which is
/// [`crate::deck_audit::record`]'s contract and holds for its reason twice over. Before, because
/// the `deck_cards` rows *are* the statement of which printings and how many — a release run
/// against an already-emptied pile reads nothing and moves nothing, and fails silently while
/// doing it. Inside, because a clear that fails half way must have moved no card: the list and
/// the custody go together or neither goes.
///
/// **`ORDER BY id`, oldest row first**, so a printing filed in two categories of one list gives
/// its copies back in a defined order — [`release_group_copies`] clamps each row's claim at what
/// the group actually holds, so which row is served first decides which one comes up short when
/// the group holds fewer copies than the list claims.
///
/// **`delete_category`'s call carries a `deck_id` its own query did not**, and that is a
/// redundancy rather than a narrowing: it reads the category out of `deck_categories` two dozen
/// lines above precisely to learn which deck it belongs to, so the extra predicate can only ever
/// be true for the rows the `category_id` alone already selected.
///
/// # A release writes `collection_entries` and its callers still take plain `with_write`
///
/// Every command wrapper in this crate carries a line saying which write lock it took and why,
/// and the ones that reach this function used to say "a deck write moves nothing the reader
/// owns" — a sentence that reads false the moment you know this function exists. The *lock* they
/// chose is still right; only the sentence was wrong, and this is the argument, written once
/// here rather than five times over there.
///
/// [`crate::collection_source::with_write_owned`] is [`crate::sync::with_write`] plus
/// [`crate::index::lifecycle::invalidate_owned`], and the **only** thing that rebuild answers is
/// the facet index's `owned` dimension. That dimension is
/// [`crate::collection_source::owned_rowids`] —
/// `SELECT DISTINCT c.rowid FROM collection_entries e JOIN cards c ON c.id = e.card_id` — which
/// names no folder anywhere and cannot: it is the set of *cards* the reader owns a copy of,
/// somewhere. A release re-files rows **between folders**, and where the destination already
/// holds the grain it folds two rows into one; but a fold always leaves a row naming that
/// `card_id` in the destination, so the set that query answers is the set it answered before.
/// Nothing enters or leaves ownership, and an `owned` rebuild would read the whole collection to
/// arrive at the answer it already had.
///
/// `collection_folders::collection_folder_delete` reaches this same conclusion from a
/// different write, in the same words, and is the precedent rather than a coincidence: a command
/// that moves rows between folders and folds some of them away, taking plain `with_write`, is a
/// pattern this crate already has. [`crate::collection_alloc::collection_to_deck`] and
/// [`crate::collection_alloc::deck_to_collection`] remain the pair the wrappers point at as
/// taking `with_write_owned` — their own doc says why — and nothing here changes that.
pub(crate) fn release_live_copies(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    category_id: Option<i64>,
) -> Result<(), String> {
    if variant != LIVE {
        return Ok(());
    }
    let held: Vec<(String, Option<String>, i64)> = tx
        .prepare(
            "SELECT card_id, finish, quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2
                AND (?3 IS NULL OR category_id = ?3)
              ORDER BY id",
        )
        .and_then(|mut s| {
            s.query_map(params![deck_id, variant, category_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;
    for (card_id, finish, quantity) in held {
        release_group_copies(tx, deck_id, &card_id, finish.as_deref(), quantity)?;
    }
    Ok(())
}

/// Give a deck the group that holds its copies, named after it.
///
/// **Called from inside the caller's transaction**, [`crate::deck_meta::ensure_predefined_categories`]'
/// contract and for its reason: a deck that exists without the row saying where its cards sit is
/// a state nothing downstream expects, so the two commit together or neither does.
///
/// `sort_order` is 0, exactly as schema v25's backfill writes it: a deck's group is not
/// something the reader ordered, and `collection_folders::list_folders` sorts by name within a
/// parent anyway.
///
/// The partial unique index `idx_collection_folder_deck` is what makes a second group for one
/// deck impossible, so this insert is also the assertion that there is at most one.
fn create_deck_group(tx: &Connection, deck_id: i64, name: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO collection_folders
             (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES (NULL, ?2, ?3, ?1, 0, unixepoch(), unixepoch())",
        params![deck_id, name, DECK_GROUP_KIND],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Make a deck — **the whole of it, in one statement** — and give it its four predefined
/// categories in the same transaction.
///
/// The categories are here because a deck that exists but cannot be filed into anything is a
/// state nothing downstream expects, and the v8 migration only ever seeded these for decks that
/// existed *at* the migration; a deck made afterwards needs the same four rows made for it here.
/// `deck_meta::ensure_predefined_categories` says on its own doc why it takes no transaction of
/// its own — this is the call that supplies one.
///
/// Every column [`DeckInput`] carries is written by the one INSERT, so the deck the user
/// described either exists as they described it or does not exist at all. Two rules hold that
/// statement together and neither is visible from the SQL alone:
///
/// * **No `coalesce` on `folder_id`.** [`update_deck`] wraps every column in one so that an
///   absent patch field means "leave it"; there is nothing here to leave, so a `None` is filed
///   at the root of the tree and means it. [`DeckInput::folder_id`] carries the full contrast.
/// * **`theory_enabled`'s absence is resolved in Rust, not in SQL.** The column is
///   `NOT NULL DEFAULT 0`, so a bound NULL would fail the write outright — and spelling a
///   `coalesce(?n, 0)` to avoid that would put the patch's convention into a statement that
///   deliberately does not use it. `unwrap_or(false)` says the same thing without the echo.
/// * **The format is remembered in [`K_LAST_DECK_FORMAT`], here and not at the call sites.**
///   Three things about that line are invisible from it. It writes the **validated** key, so a
///   blank `formatKey` is remembered as [`DEFAULT_FORMAT`] — what the deck actually is, not what
///   the caller failed to say. Its error is **deliberately dropped**: a remembered preference
///   must never cost the reader their deck, which is the exact contrast with the
///   [`crate::deck_audit::record`] two lines below it, `?`-propagated because a deck's history
///   is part of the deck. And it sits **inside the transaction**, so a create that is refused or
///   rolled back remembers nothing. Here rather than at the two call sites because both — the
///   gallery's create dialog, and `useDeckImport`'s import-into-a-new-deck, which is a
///   `deck_create` followed by `deck_import_commit` — come through this function.
///
/// `cover_kind` is absent from the column list on purpose and takes its DDL default,
/// [`COVER_CARD_ART`]; [`DeckInput`] says why the other word cannot be reached from here.
pub fn create_deck(conn: &Connection, input: &DeckInput) -> Result<DeckRow, String> {
    let name = valid_name(&input.name)?;
    let format_key = valid_format(conn, &input.format_key)?;
    let game_key = valid_game(&input.game_key)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let id: i64 = tx
        .query_row(
            "INSERT INTO decks (name, format_key, game_key, description, notes, cover_card_id,
                                folder_id, theory_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch(), unixepoch())
             RETURNING id",
            params![
                name,
                format_key,
                game_key,
                input.description,
                input.notes,
                input.cover_card_id,
                input.folder_id,
                input.theory_enabled.unwrap_or(false),
            ],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    crate::deck_meta::ensure_predefined_categories(&tx, id)?;
    create_deck_group(&tx, id, name)?;
    // **And the group its copies sit in**, for the categories' reason exactly one table over:
    // schema v25 gave one to every deck that already existed, and a deck made afterwards needs
    // the same row made for it here or it is the one deck in the database that can hold nothing.
    // The first line of the deck's history, and the one place a `deck` row carries a `from` of
    // null: there was no previous name, because there was no deck. Recorded here rather than
    // left out so that a drawer scrolled to the bottom ends at the deck's own beginning
    // instead of at whatever edit happens to be oldest.
    //
    // **One row, however many fields the deck was born with.** [`update_deck`] writes one per
    // field that moved because each of those is a change to something that already had a value;
    // a create has no `from` side to compare against, and seven lines under one press would read
    // as a deck somebody spent an evening editing. `deck_audit`'s
    // `every_deck_write_leaves_exactly_one_audit_row` counts exactly this one.
    crate::deck_audit::record(
        &tx,
        id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &json!({ "field": "name", "from": null, "to": name }),
        0,
    )?;
    // What the New deck dialog will open on next time. The **validated** key, so a blank
    // `formatKey` is remembered as `DEFAULT_FORMAT` rather than as an empty string; inside the
    // transaction, so a create that rolls back remembers nothing; and the error deliberately
    // dropped, unlike the `?` two lines above — losing a preference is not worth losing a deck
    // over. See this function's doc.
    let _ = crate::app_meta::set_app_meta(&tx, K_LAST_DECK_FORMAT, format_key);
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// The format the last deck was created in, exactly as [`create_deck`] recorded it — or `None`
/// when no deck has ever been made here.
///
/// **Not validated against `format_specs`, and deliberately not defaulted.** Rust supplies the
/// fact ("this is the key the last created deck carried"); TypeScript draws the conclusions —
/// whether the picker still offers that format, and what to open on instead. That is the
/// crate's own boundary, and it is why this answers an `Option` rather than falling back the way
/// [`crate::marketplace::stored`] does: the fallback the dialog wants is Commander, which is a
/// display decision, while the fallback SQL would supply is [`DEFAULT_FORMAT`], which is the
/// column's default and not anybody's preference. Neither belongs in this answer.
pub fn last_deck_format(conn: &Connection) -> Option<String> {
    crate::app_meta::get_app_meta(conn, K_LAST_DECK_FORMAT)
}

/// One `decks` row as it was before an edit — every column [`DeckPatch`] can reach, read
/// inside the transaction so the `from` side of a history row is the value the UPDATE is
/// actually about to replace.
struct DeckBefore {
    name: String,
    format_key: String,
    game_key: String,
    description: Option<String>,
    cover_card_id: Option<String>,
    cover_kind: String,
    archived: bool,
    folder_id: Option<i64>,
    notes: Option<String>,
    theory_enabled: bool,
    separate_x_group: bool,
    default_category_id: i64,
    bracket: i64,
}

/// What a `deck`/`cover` history row records as the cover: the card's id, and the word
/// [`COVER_CUSTOM`] on the one kind of row that can still carry it.
///
/// **The interesting case is now the only one this branch exists for.** Custom covers went on
/// 2026-08-31, so nothing here writes `custom` — but `cover_kind` is a synced field, a device
/// still on the old rung can push a `custom` row onto this one, and the *first* edit made to
/// such a deck is a history line whose `from` side describes what the reader was looking at. A
/// card id there would name the cover the tile had already fallen back to rather than the one
/// that was stored, which is a history that disagrees with the screen.
///
/// The file's path was never written and could not be now: it was a path on one machine, it
/// said nothing a reader wants, and it was not what the change was about.
fn cover_value(kind: &str, cover_card_id: Option<&str>) -> serde_json::Value {
    if kind == COVER_CUSTOM {
        json!(COVER_CUSTOM)
    } else {
        json!(cover_card_id)
    }
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed — `collection::update_entry`
/// verbatim. Rename, re-format, cover, build, archive and filing all arrive here.
///
/// **One history row per field that actually changed**, which is a narrower rule than "one per
/// call" and a wider one than "one per press". A patch that asks for the value a field already
/// has changed nothing and records nothing — otherwise every Save on an untouched form would
/// fill the drawer with edits nobody made. A patch that changes two fields is two facts, and
/// the `deck` payload names one field: the alternative would be choosing which half of the
/// user's edit is remembered. The editor sends one field at a time, which is why
/// `every_deck_write_leaves_exactly_one_audit_row` counts one here.
pub fn update_deck(conn: &Connection, id: i64, patch: &DeckPatch) -> Result<DeckRow, String> {
    let name = match patch.name.as_deref() {
        Some(n) => Some(valid_name(n)?.to_owned()),
        None => None,
    };
    let format_key = match patch.format_key.as_deref() {
        Some(k) => Some(valid_format(conn, k)?.to_owned()),
        None => None,
    };
    let game_key = match patch.game_key.as_deref() {
        Some(g) => Some(valid_game(g)?.to_owned()),
        None => None,
    };
    // Validated **before the transaction opens**, with the three above it: a refusal here is
    // about the value the caller sent and has nothing to say about the deck, so there is
    // nothing to roll back and no reason to have taken a write lock to find out.
    let bracket = patch.bracket.map(valid_bracket).transpose()?;
    // **One transaction, because a rename is two writes.** `decks.name` and the name on the
    // `collection_folders` row standing for the deck are one fact stored twice — nothing in the
    // schema keeps them in step — so a rename that committed one and lost the other would leave
    // the folder tree calling a deck something the gallery does not. The theory move below wants
    // the same guarantee for the same reason.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Read before write, so the history's `from` side is what this UPDATE is about to replace.
    // Inside the transaction, because a value read outside one could have moved by the time
    // the UPDATE ran and the row would then record a change that never happened.
    let before: DeckBefore = tx
        .query_row(
            "SELECT name, format_key, description, cover_card_id, cover_kind,
                    archived, folder_id, notes, theory_enabled, separate_x_group,
                    default_category_id, game_key, bracket
               FROM decks WHERE id = ?1",
            params![id],
            |r| {
                Ok(DeckBefore {
                    name: r.get(0)?,
                    format_key: r.get(1)?,
                    description: r.get(2)?,
                    cover_card_id: r.get(3)?,
                    cover_kind: r.get(4)?,
                    archived: r.get(5)?,
                    folder_id: r.get(6)?,
                    notes: r.get(7)?,
                    theory_enabled: r.get(8)?,
                    separate_x_group: r.get(9)?,
                    default_category_id: r.get(10)?,
                    // Last in the list, `DECK_SELECT`'s rule for its own reason: these reads
                    // are positional too, and `game_key` is TEXT like four of the columns
                    // above it — and every index above moved down by one when schema v25
                    // dropped `is_built` out of the middle of the list.
                    game_key: r.get(11)?,
                    // 12, at the end, same rule. `bracket` is an INTEGER and so are `archived`
                    // at 5, `folder_id` at 6, `theory_enabled` at 8, `separate_x_group` at 9
                    // and `default_category_id` at 10 — six columns any one of which would take
                    // a bracket without complaint.
                    bracket: r.get(12)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;
    // The undo step's "before", read whole rather than rebuilt from [`DeckBefore`] — that
    // struct carries only the columns the *history* compares and this needs every column a
    // step may write (`deck_undo::DECK_FIELDS`).
    // `last_variant` is the one that makes the difference rather than a completeness argument:
    // the theory arm below moves it to `theory`, and it is not on `DeckBefore` at all.
    let row_before = crate::deck_undo::read_deck_row(&tx, id)?;
    // **The fence the DDL cannot hold.** `default_category_id` carries no foreign key — `0`
    // means Auto and a `REFERENCES` clause cannot be added to a column whose default is not
    // NULL — so this is where "a deck's default pile is a pile of *that* deck" actually lives,
    // exactly as [`category_of_deck`] is where the same rule lives for every card write. The
    // name it hands back is what the history row below quotes, so the check costs no second
    // query. `Some(0)` is Auto and names no category, so it is not asked about.
    let default_category_name = match patch.default_category_id.filter(|c| *c != AUTO_CATEGORY) {
        Some(category_id) => Some(category_of_deck(&tx, id, category_id)?),
        None => None,
    };
    let changed = tx
        .execute(
            "UPDATE decks SET
                name = coalesce(?2, name),
                format_key = coalesce(?3, format_key),
                description = coalesce(?4, description),
                cover_card_id = coalesce(?5, cover_card_id),
                -- **The one writer of this column left, and it is a repair as well as a
                -- write.** Nothing writes 'custom' any more, so on a database that has taken
                -- the rung this is `card_art` over `card_art` — but `cover_kind` syncs, and a
                -- device still on the old rung can push a 'custom' row here; picking a card is
                -- what puts that row back on the only word this app means. Bound rather than
                -- spelled, so the word this writes and the word `cover_value` reads are one
                -- constant.
                cover_kind = CASE WHEN ?5 IS NULL THEN cover_kind ELSE ?10 END,
                archived = coalesce(?6, archived),
                folder_id = coalesce(?7, folder_id),
                notes = coalesce(?8, notes),
                theory_enabled = coalesce(?9, theory_enabled),
                -- `?11` and not `?10`: that hole is `COVER_CARD_ART` above, which is bound
                -- rather than spelled. A new column takes the next number at the **end** of the
                -- list, never the next one that reads free — and a *dropped* column renumbers
                -- every hole after it, which is what v25 taking `is_built` out did to these.
                separate_x_group = coalesce(?11, separate_x_group),
                default_category_id = coalesce(?12, default_category_id),
                game_key = coalesce(?13, game_key),
                -- `?14`, the next number at the **end** of the list, which is the rule the
                -- comment nine lines up states. The **validated** binding rather than
                -- `patch.bracket`: `valid_bracket` ran above, and binding the raw field would
                -- make the fence decorative on exactly the path it exists for.
                bracket = coalesce(?14, bracket),
                updated_at = unixepoch()
              WHERE id = ?1",
            params![
                id,
                name,
                format_key,
                patch.description,
                patch.cover_card_id,
                patch.archived,
                patch.folder_id,
                patch.notes,
                patch.theory_enabled,
                COVER_CARD_ART,
                patch.separate_x_group,
                patch.default_category_id,
                game_key,
                bracket,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
    // **The deck's group wears the deck's name, and this is the only thing keeping it there.**
    // `collection_folders.name` is a snapshot taken when the group was made — by
    // [`create_deck_group`] or by schema v25's backfill — and no trigger, no view and no foreign
    // key updates it, so a rename that stopped here would leave the collection's folder tree
    // labelled with a name the gallery stopped using months ago. The **trimmed** name, because
    // that is the name the deck itself got: `valid_name` ran above and the two must agree.
    //
    // Only when the name actually moved, [`record_deck_edit`]'s rule and for its reason: a
    // patch that re-sends the value a field already holds changed nothing, and a folder write
    // on every Save of an untouched form is a write nobody asked for.
    if let Some(to) = name.as_deref().filter(|n| *n != before.name) {
        tx.execute(
            "UPDATE collection_folders SET name = ?2, updated_at = unixepoch()
              WHERE deck_id = ?1",
            params![id, to],
        )
        .map_err(|e| e.to_string())?;
    }
    // **Switching the theory list on MOVES the live list into it, in this transaction.** The
    // deck the reader has built is the plan — they typed it out of a list, not out of a box —
    // and the live list is what they have since sleeved up, which on the day the switch is
    // pressed is nothing. The flag and the move are one fact: a flag that committed while the
    // move rolled back is the empty theory list beside a full live one that this exists to
    // prevent, and the move is what makes the reallocation below owing, so all of it commits
    // together or not at all.
    //
    // Only on the *transition*, and only when there is nothing there. A plan the user has
    // started is not something a re-press of the switch may pour the live deck over
    // (`enabling_theory_again_leaves_a_started_plan_alone`), and that emptiness is load-bearing
    // for a second reason [`crate::deck_theory::move_live_into_theory`] states: `variant` is in
    // `DECK_CARD_GRAIN`, so re-labelling a live row over a theory row of the same category and
    // printing is a UNIQUE failure rather than a wrong answer.
    //
    // **The undo step's "before" for the cards has to be read between the test and the move**,
    // which is the whole reason the condition is split in two here rather than left as one
    // `&&` chain. The move is a bare `UPDATE … SET variant`, so once it has run there is
    // nothing left anywhere saying which rows were live — that is the same hole in the audit
    // log's `{field:"theory",from:false,to:true}` that made this feature need a journal at all.
    // Reading both variants unconditionally would be two queries on every rename.
    let will_move = patch.theory_enabled == Some(true)
        && !before.theory_enabled
        && crate::deck_theory::theory_is_empty(&tx, id)?;
    let cards_before = match will_move {
        true => Some((
            crate::deck_undo::read_variant(&tx, id, LIVE)?,
            crate::deck_undo::read_variant(&tx, id, THEORY)?,
        )),
        false => None,
    };
    // How many rows moved is no longer worth binding: it used to decide whether the deck owed a
    // reallocation, and since schema v25 nothing here does.
    if will_move {
        crate::deck_theory::move_live_into_theory(&tx, id)?;
    }
    let audit_id = record_deck_edit(
        &tx,
        id,
        patch,
        &DeckResolved {
            name: &name,
            format_key: &format_key,
            game_key: &game_key,
            default_category_name: default_category_name.as_deref(),
        },
        &before,
    )?;
    // No history row means nothing changed, and a step for a change that did not happen is a
    // Ctrl+Z that appears to do nothing — `a_patch_that_changes_nothing_records_nothing`'s rule,
    // carried into the journal.
    if let Some(audit_id) = audit_id {
        let mut undo = vec![crate::deck_undo::Op::Deck { fields: row_before }];
        let mut redo = vec![crate::deck_undo::Op::Deck {
            fields: crate::deck_undo::read_deck_row(&tx, id)?,
        }];
        if let Some((live, theory)) = cards_before {
            undo.push(crate::deck_undo::Op::Variant {
                variant: LIVE.to_owned(),
                rows: live,
            });
            undo.push(crate::deck_undo::Op::Variant {
                variant: THEORY.to_owned(),
                rows: theory,
            });
            redo.push(crate::deck_undo::Op::Variant {
                variant: LIVE.to_owned(),
                rows: crate::deck_undo::read_variant(&tx, id, LIVE)?,
            });
            redo.push(crate::deck_undo::Op::Variant {
                variant: THEORY.to_owned(),
                rows: crate::deck_undo::read_variant(&tx, id, THEORY)?,
            });
        }
        crate::deck_undo::record_step(&tx, audit_id, id, &crate::deck_undo::Step::new(undo, redo))?;
    }
    // **Nothing is reallocated here, and there is no longer anything to reallocate.** Until
    // schema v25 the theory move above owed one: claims were held for `live` only, so emptying
    // the live list stranded every claim this deck held. A group is custody rather than a claim
    // and is not scoped to a variant at all — the copies stay exactly where they physically are
    // while the plan moves — so a deck whose live list has just been emptied still holds its
    // cards, which is the truth about a deck somebody is re-planning.
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// The three values [`update_deck`] validated out of a [`DeckPatch`], plus the one it looked up
/// — everything the history needs that the patch does not already carry verbatim.
///
/// **A struct rather than four more parameters, and clippy is only half the reason.** The
/// signature reached eight arguments when `game_key` joined it and `too_many_arguments` (7)
/// failed the build — but the grouping is the honest shape anyway: these four share one
/// property that none of `tx`, `id`, `patch` or `before` has, which is that they are the
/// *patch's own fields after Rust has had its say*. A blank `formatKey` is [`DEFAULT_FORMAT`]
/// here and a blank `gameKey` is [`DEFAULT_GAME`], so what the history compares is what was
/// written rather than what was typed.
struct DeckResolved<'a> {
    /// Through [`valid_name`] — trimmed.
    name: &'a Option<String>,
    /// Through [`valid_format`] — a key `format_specs` carries, or [`DEFAULT_FORMAT`].
    format_key: &'a Option<String>,
    /// Through [`valid_game`] — one of [`crate::schema::DECK_GAMES`], or [`DEFAULT_GAME`].
    game_key: &'a Option<String>,
    /// The name [`update_deck`]'s fence already resolved for `patch.default_category_id`, or
    /// `None` where the patch names no pile *or* names [`AUTO_CATEGORY`]. The one field here
    /// that is a *lookup* rather than a validation, which is why it is a name and not a key.
    default_category_name: Option<&'a str>,
}

/// Write [`update_deck`]'s history: one row per field whose value actually moved.
///
/// `name` and `format_key` arrive already validated and canonicalised (a blank format key is
/// [`DEFAULT_FORMAT`] by then), so what is compared here is what was written and not what was
/// typed — a patch that sends `"  Burn  "` for a deck already called `Burn` records nothing,
/// which is the honest answer.
///
/// **Filing a deck is a `folder` row, not a `deck` one**, and that is the one asymmetry worth
/// naming: `deck_folders` is the only thing a deck can point at that has a *name of its own*,
/// and a bare folder id in a `deck` row's `to` would be a number no reader could resolve once
/// the folder was renamed. The path is resolved here, at the moment it is true.
fn record_deck_edit(
    tx: &Connection,
    id: i64,
    patch: &DeckPatch,
    resolved: &DeckResolved<'_>,
    before: &DeckBefore,
) -> Result<Option<i64>, String> {
    let DeckResolved {
        name,
        format_key,
        game_key,
        default_category_name,
    } = *resolved;
    // The **last** row this writes, which is what the undo journal keys its one step on. A
    // patch that changes two fields is two history rows and one Ctrl+Z: one press is one
    // reversal, and a cursor that could land between the two would put half a form back.
    let mut last = None;
    let mut field = |field: &str, from: serde_json::Value, to: serde_json::Value| {
        last = Some(crate::deck_audit::record(
            tx,
            id,
            crate::deck_audit::DECK_LEVEL,
            crate::deck_audit::DECK,
            None,
            &json!({ "field": field, "from": from, "to": to }),
            0,
        )?);
        Ok::<(), String>(())
    };
    if let Some(to) = name.as_deref().filter(|n| *n != before.name) {
        field("name", json!(before.name), json!(to))?;
    }
    if let Some(to) = format_key.as_deref().filter(|k| *k != before.format_key) {
        field("format", json!(before.format_key), json!(to))?;
    }
    // `game`, and the **key** rather than a display word: `auditText.ts` is the only thing that
    // words a history row, and it is the only place that knows Paper from `paper`. The two
    // spellings of this field name are the one thing that can drift silently — the `default`
    // arm answers an unrecognised field with "Changed the deck", which is true of every deck
    // edit and therefore never fails — which is the trap `xGroup` documents one arm down.
    if let Some(to) = game_key.as_deref().filter(|g| *g != before.game_key) {
        field("game", json!(before.game_key), json!(to))?;
    }
    if let Some(to) = patch
        .description
        .as_deref()
        .filter(|d| Some(*d) != before.description.as_deref())
    {
        field("description", json!(before.description), json!(to))?;
    }
    // A cover change is "which picture is showing", so a card id that is already stored still
    // changes the cover when the deck's row had arrived from an un-upgraded device saying
    // `custom` — and the `from` side says so rather than naming the card underneath it. See
    // [`cover_value`].
    let cover_was = cover_value(&before.cover_kind, before.cover_card_id.as_deref());
    if let Some(to) = patch
        .cover_card_id
        .as_deref()
        .filter(|c| json!(*c) != cover_was)
    {
        field("cover", cover_was, json!(to))?;
    }
    if let Some(to) = patch.archived.filter(|a| *a != before.archived) {
        field("archived", json!(before.archived), json!(to))?;
    }
    if let Some(to) = patch
        .notes
        .as_deref()
        .filter(|n| Some(*n) != before.notes.as_deref())
    {
        field("notes", json!(before.notes), json!(to))?;
    }
    // One row, whether or not the theory list was seeded above: the seeding is part of
    // switching the list on, not a second edit, and N `add` rows for one press would read as a
    // deck somebody typed out.
    if let Some(to) = patch.theory_enabled.filter(|t| *t != before.theory_enabled) {
        field("theory", json!(before.theory_enabled), json!(to))?;
    }
    // `xGroup`, camelCase like every other key in a `deck` payload — `src/features/decks/
    // auditText.ts` is the only thing that words these, and it matches on the field name.
    if let Some(to) = patch
        .separate_x_group
        .filter(|x| *x != before.separate_x_group)
    {
        field("xGroup", json!(before.separate_x_group), json!(to))?;
    }
    // **Names, never ids** — `record_filed`'s rule one bullet down, for its reason: a bare
    // category id in a `to` is a number no reader can resolve once the pile has been renamed or
    // deleted, and this drawer is read months later. `null` is Auto on both sides, which is what
    // `auditText.ts` words as "by what the card does".
    //
    // The `from` side is looked up here rather than carried on [`DeckBefore`], because it is
    // wanted only on the writes that move this field and a join on every deck edit to answer a
    // question nobody asked is a query per rename.
    if let Some(to) = patch
        .default_category_id
        .filter(|c| *c != before.default_category_id)
    {
        let was = category_name(tx, before.default_category_id)?;
        field(
            "defaultCategory",
            json!(was),
            json!(if to == AUTO_CATEGORY {
                None
            } else {
                default_category_name
            }),
        )?;
    }
    // `bracket`, and the **number** rather than a word — `format`'s rule two dozen lines up, for
    // its reason: `auditText.ts` is the only thing that words a history row, and it is the only
    // place that knows `4` from "Optimized". `0` on either side is Auto, which that file words
    // as the app's own estimate standing.
    //
    // Read off `patch` rather than off a [`DeckResolved`] field, unlike `name`, `format` and
    // `game`: [`valid_bracket`] refuses or returns the number it was given, so there is no
    // "what was written" that differs from "what was typed" for this one — `archived` and
    // `xGroup` are compared the same way for the same reason.
    if let Some(to) = patch.bracket.filter(|b| *b != before.bracket) {
        field("bracket", json!(before.bracket), json!(to))?;
    }
    if let Some(to) = patch.folder_id.filter(|f| Some(*f) != before.folder_id) {
        last = Some(record_filed(tx, id, Some(to))?);
    }
    Ok(last)
}

/// File a deck under a folder, or — with `None` — back at the **root of the tree**.
///
/// A command of its own rather than a [`DeckPatch`] field, and the reason is the convention
/// every column in that struct is written under: `coalesce(?n, column)` reads a bound NULL as
/// "leave it", so within a patch `null` cannot mean "clear it". A double-`Option` (absent versus
/// null) would express it, but only across the *whole* struct, and inventing a second convention
/// inside one that already has one is how a reader comes to distrust both. Here `None` genuinely
/// means root, because there is nothing else it could mean.
///
/// `DeckPatch::folder_id` stays exactly as it is for the set-a-folder case; this is the one that
/// can also take it back out.
///
/// Records one `folder` row **when the deck actually moves**, [`update_deck`]'s rule: a dialog
/// that saves an untouched form must not fill the drawer with moves nobody made. The
/// `updated_at` touch is unconditional, also [`update_deck`]'s.
pub fn set_folder(
    conn: &Connection,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Validated in words rather than left to the foreign key. `decks.folder_id` does declare
    // `REFERENCES deck_folders(id)`, but `PRAGMA foreign_keys` is a per-connection setting and a
    // constraint failure names the table and not the mistake — the same reason
    // `valid_format` checks `format_specs` by hand.
    if let Some(folder) = folder_id {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deck_folders WHERE id = ?1)",
                params![folder],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(crate::deck_meta::FOLDER_GONE.to_owned());
        }
    }
    let before: Option<i64> = tx
        .query_row(
            "SELECT folder_id FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;
    touch_deck(&tx, deck_id)?;
    tx.execute(
        "UPDATE decks SET folder_id = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![deck_id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    if folder_id != before {
        let audit_id = record_filed(&tx, deck_id, folder_id)?;
        // `folder_id` alone, not the whole row: this command writes one column and **`None` is
        // a real value here** rather than "leave it" — which is the whole reason this is a
        // command and not a `DeckPatch` field, and it is what lets an undo put a deck back at
        // the root of the tree.
        crate::deck_undo::record_step(
            &tx,
            audit_id,
            deck_id,
            &crate::deck_undo::Step::new(
                vec![crate::deck_undo::Op::Deck {
                    fields: json_field("folder_id", before),
                }],
                vec![crate::deck_undo::Op::Deck {
                    fields: json_field("folder_id", folder_id),
                }],
            ),
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, deck_id)?.ok_or_else(|| GONE.to_owned())
}

/// One `decks` column and its value, as an [`crate::deck_undo::Op::Deck`] carries them.
fn json_field(
    field: &str,
    value: impl Into<serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    map.insert(field.to_owned(), value.into());
    map
}

/// The one `folder` history row, written by every writer that can file a deck: the two here,
/// and [`crate::deck_meta::delete_folder`], which un-files every deck in the folder it
/// destroys.
///
/// `None` is the root of the tree and records `"folder": null` — the absence of a path, not the
/// empty string, because a reader has to be able to tell "filed nowhere" from "filed under a
/// folder whose name is blank" and only one of those is a state the app can produce.
pub(crate) fn record_filed(
    tx: &Connection,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<i64, String> {
    let folder = match folder_id {
        Some(id) => json!(folder_path(tx, id)?),
        None => json!(null),
    };
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::FOLDER,
        None,
        &json!({ "action": "move", "folder": folder }),
        0,
    )
}

/// A folder's full path, root first, joined with ` › ` — `"Commander › Legends"`.
///
/// Resolved at write time and stored in the history row, which is deliberate and is the
/// opposite of what every other reference in this schema does: a `folder_id` would be the
/// normalised thing to keep, and it would be **wrong here**, because a history says what was
/// true then. A folder renamed or deleted afterwards must not rewrite the line that recorded
/// the move.
///
/// Walks `parent_id` upward with a hop budget rather than an unbounded loop: `move_folder`
/// refuses a cycle, so the tree cannot hold one — but this walk runs over data, and a walk
/// over data that trusts an invariant is a walk that hangs the day the invariant is wrong. A
/// path that exceeds the budget is answered as far as it was read.
fn folder_path(conn: &Connection, folder_id: i64) -> Result<String, String> {
    /// Deep enough that no filing anyone does by hand reaches it.
    const MAX_DEPTH: usize = 64;

    let mut names: Vec<String> = Vec::new();
    let mut cursor = Some(folder_id);
    while let Some(id) = cursor {
        if names.len() >= MAX_DEPTH {
            break;
        }
        let row: Option<(String, Option<i64>)> = conn
            .query_row(
                "SELECT name, parent_id FROM deck_folders WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((name, parent)) = row else { break };
        names.push(name);
        cursor = parent;
    }
    names.reverse();
    Ok(names.join(" › "))
}

/// What [`set_view_state`] says when it is handed a blank where a mode should be.
///
/// The whole of what Rust checks about [`DeckViewState::group_by`] and
/// [`DeckViewState::sort_by`]: the words themselves are TypeScript's vocabulary and this crate
/// deliberately does not know them (see [`DeckRow::last_group_by`]), but an empty string is not
/// one of them in any vocabulary — it is a bug in the caller, and storing it would hand the
/// editor back a remembered choice of nothing.
const NO_MODE: &str = "A remembered view mode cannot be blank.";

/// Remember where the reader was looking at this deck: which list, and how the editor was
/// grouping and sorting it.
///
/// Absent fields are left alone (`coalesce(?n, column)`), [`update_deck`]'s convention — the
/// editor sends the one control that moved, not the three it has.
///
/// **It is not an edit, and the three things it does not do are the point.**
///
/// * **It does not touch `updated_at`.** Reading a deck is not editing it. The gallery sorts on
///   that column, so touching it would move a deck to the top of "most recently touched" because
///   somebody opened its Theory tab — a lie about what happened, told to the one view whose job
///   is to say what the reader was last working on.
/// * **It records no `deck_audit` row.** The history holds changes to the deck; which tab was
///   open is not one, and a drawer that said "switched to Theory" between two real edits would
///   be worse than one that said nothing. It is the seventh deliberate exception to
///   [`crate::deck_audit`]'s one-row rule, listed there with the other six.
/// * **It moves no collection row.** Nothing here changes what the deck lists, so nothing
///   changes what it holds — and since schema v25 there is no list of writes to join: what a
///   deck owns is a sum over the rows filed in its group ([`owned_by_oracle`]), so nothing is
///   derived and no write can forget to rebuild it. This bullet named "the allocator" and
///   pointed at a list in `src-tauri/CLAUDE.md` that the same rung deleted. What is left to
///   say is the narrower fact: reading a deck may not file a card into or out of its group,
///   and this does not.
///
/// A deck id that resolves to nothing is [`GONE`], like every other deck write: a stale editor
/// deserves the sentence rather than a write that silently lands nowhere.
pub fn set_view_state(conn: &Connection, id: i64, state: &DeckViewState) -> Result<(), String> {
    // The variant fence every deck write opens with, over `DECK_VARIANTS` — and here it is the
    // *only* fence there is, because `ALTER TABLE ADD COLUMN` cannot carry a CHECK (schema v12
    // says so at the column). `deck_meta::valid_variant` rather than a second spelling of it:
    // one definition of "is that a variant" is what keeps every refusal in the crate identical.
    let variant = match state.variant.as_deref() {
        Some(v) => Some(crate::deck_meta::valid_variant(v)?),
        None => None,
    };
    // A named `fn` rather than a closure: a closure over `Option<&str>` in and out ties the
    // borrow it is handed to the one it returns and will not compile.
    fn mode(m: Option<&str>) -> Result<Option<&str>, String> {
        match m {
            Some(m) if m.trim().is_empty() => Err(NO_MODE.to_owned()),
            other => Ok(other),
        }
    }
    let group_by = mode(state.group_by.as_deref())?;
    let sort_by = mode(state.sort_by.as_deref())?;
    let changed = conn
        .execute(
            "UPDATE decks SET
                last_variant = coalesce(?2, last_variant),
                last_group_by = coalesce(?3, last_group_by),
                last_sort_by = coalesce(?4, last_sort_by)
              WHERE id = ?1",
            params![id, variant, group_by, sort_by],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0).then_some(()).ok_or_else(|| GONE.to_owned())
}

/// Delete the deck outright.
///
/// **This one really deletes**, unlike anything in [`crate::reconcile`]: a deck is the
/// user's to destroy, and `deck_cards`, `deck_categories`, `deck_audit`, `deck_undo` and the
/// deck's own `collection_folders` row all cascade from it by a choice made per delete-site.
/// Archiving is the soft path ([`DeckPatch::archived`]), and it is what a gallery's "remove"
/// should reach for.
///
/// Like [`crate::collection::remove_entry`], an id that resolves to nothing is a success:
/// the caller wanted that deck gone, and it is gone.
///
/// # The cards in it are not the deck's to destroy
///
/// A `deck_cards` row is an intention and dies with the deck that held it. A row in the deck's
/// **group** is a card the reader physically owns, so it goes to `Recently removed` — the one
/// place copies wait when they have left the collection's shelves without leaving the database.
/// The group itself goes: `collection_folders.deck_id` is `ON DELETE CASCADE`, because a folder
/// that *stands for* a deck has no meaning once the deck is gone.
///
/// **By hand, one at a time, and before the `DELETE`** — [`crate::collection_folders::delete_folder`]'s
/// rule, borrowed rather than re-argued. `collection_entries.folder_id` is `ON DELETE SET NULL`
/// and would scatter the cards to the root, which is both the wrong destination and a rewrite of
/// the eleventh term of [`crate::schema::COLLECTION_GRAIN`] with nothing saying what it will land
/// on. One at a time is what makes the collision that is actually **reachable** merge instead of
/// raising `UNIQUE constraint failed: index 'idx_collection_grain'`, and which collision that is
/// is worth naming, because the obvious answer is the wrong one: it is *not* two of this deck's
/// own rows landing on one grain. Two rows filed in one folder already differ in one of the
/// grain's other ten terms, and no command nests a sub-folder under a deck's group, so the deck
/// never hands over two rows that could collide with each other. What it hands over is a
/// printing **already waiting in `Recently removed`** — cut from this very deck last week — and
/// that is the row the arriving one folds into. `ORDER BY e.id` still makes which row survives a
/// fact about the table rather than about the planner.
///
/// **[`crate::collection_folders::refile_entry`] rather than `set_entry_folder`**, because the
/// command refuses to file anything into a `removed` folder by hand and is right to — that is a
/// sentence the app is responsible for, not one a reader may assert by dragging. This is the app
/// saying it.
///
/// One transaction throughout: mid-delete the cards are all in the holding area and the deck is
/// gone, or none of it happened. Nothing is outside it: this took a covers directory and
/// removed the deck's `<id>.webp` after the commit until custom covers went on 2026-08-31, and
/// with that gone a deck is rows and only rows.
///
/// **Records nothing**, and cannot: `deck_audit.deck_id` is `NOT NULL` and CASCADEs from
/// `decks`, so a row written to say "this deck was deleted" would be removed by the very
/// statement that made it true. It is the one deck write with no history, because it is the
/// one deck write with nothing left to file a history under —
/// `deleting_a_deck_takes_its_history_with_it` pins that this is a property of the schema and
/// not an omission.
///
pub fn delete_deck(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(group) = deck_group(&tx, id)? {
        // **The destination is looked up rather than assumed.** Schema v25 creates exactly one
        // `removed` folder and the partial unique index makes a second impossible, so `None`
        // here is a database somebody has edited by hand — and the honest answer to that is the
        // root, which is where `collection_entries.folder_id`'s SET NULL would have put these
        // rows anyway. A refusal would be a deck the reader can never delete.
        let removed = removed_group(&tx)?;
        // **The whole sub-tree, in the database rather than in a Rust walk** — the recursive
        // half of [`crate::collection_folders::delete_folder`]'s query, for its reason: the
        // cascade this stands in front of is itself recursive (`collection_folders.parent_id`
        // is `ON DELETE CASCADE` onto its own table), and the two must agree about which
        // folders are doomed.
        //
        // **No command can nest a folder under a deck's group today** — `create_folder` and
        // `move_folder` both refuse a parent the app owns — so this rung finds exactly the one
        // folder on every real database. It is here because the *DDL* allows what those two
        // refuse, and the day a command permits it the alternative is not a wrong number but
        // a sub-tree's worth of cards scattered to the root by `SET NULL`.
        //
        // `UNION` and never `UNION ALL`, and `ORDER BY e.id` so the row a merge folds into is
        // decided by the table and not by the planner — both `delete_folder`'s, verbatim.
        let filed: Vec<i64> = {
            let mut stmt = tx
                .prepare(
                    "WITH RECURSIVE doomed(id) AS (
                         SELECT ?1
                         UNION
                         SELECT f.id FROM collection_folders f JOIN doomed d ON f.parent_id = d.id
                     )
                     SELECT e.id FROM collection_entries e
                      WHERE e.folder_id IN (SELECT id FROM doomed)
                      ORDER BY e.id",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![group], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?
        };
        // A merge only ever deletes the row it was *given*, so no id in this list can go before
        // its turn and `refile_entry`'s `GONE` is unreachable from here. It is propagated rather
        // than skipped anyway: if it ever did fire, something is deleting entries underneath this
        // transaction, and rolling the whole press back is the only honest answer to that.
        for entry in filed {
            crate::collection_folders::refile_entry(&tx, entry, removed)?;
        }
    }
    tx.execute("DELETE FROM decks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// One `deck_cards` row on its way from a deck to its copy — every column that describes the
/// card, with the two that describe *which deck's* category and label it is (`category_id`,
/// `label_id`) still holding the source's ids, for [`duplicate_deck`] to remap.
struct CopiedCard {
    category_id: i64,
    label_id: Option<i64>,
    variant: String,
    card_id: String,
    set_code: String,
    collector_number: String,
    lang: String,
    name: String,
    quantity: i64,
    needs_review: Option<String>,
    finish: Option<String>,
}

/// Copy the deck, its categories, its labels and its cards — never the cards it **holds**, and
/// never `archived`.
///
/// A copy is a **draft**: it lists the same cards and physically holds none of them, and it is
/// not something the user filed away. So the copy gets a group of its own and that group is
/// **empty** — moving the copies would take them out of the deck that is sleeved up, and
/// duplicating a row of them would invent cards the reader does not own. `is_built` used to be
/// how a copy said it was a draft, and an empty group says it better: it is the same sentence,
/// stated as a fact about where the cards are rather than as a flag beside them.
///
/// Everything that describes the deck rather than its state — format, description, cover, notes,
/// which folder it is filed in, whether it keeps a theory list, whether it groups its X cards,
/// which bracket it is — comes across, so the copy looks like what was copied.
/// `separate_x_group` is on that side of the line for the plainest reason available: it decides
/// how the list is *read*, and a copy that reads differently from its original is a surprise
/// nobody asked for.
///
/// **`bracket` is on that side too** (schema v26), and it is worth saying which side rather than
/// leaving it to whichever list the column happened to land in: it is an answer *about the deck*,
/// the way `separate_x_group` is, and not a note about how the reader was looking at it a moment
/// ago the way the three `last_*` columns are. A copy of a deck the reader has declared a
/// bracket 2 is a bracket 2 deck; making the duplicate revert to Auto would tell them their
/// estimate had changed when only the row had.
///
/// **Both variants are copied.** A theory list is the deck's plan for itself, and a copy made
/// to try something out is exactly the copy that wants the plan too. `theory_enabled` travels
/// with them for the same reason: copying the rows and leaving the flag off would give the
/// copy a list it cannot open.
///
/// **The cover is `cover_card_id` and copies like any other column**, which is the whole of
/// what used to be this function's hardest argument. While a cover could be a *file* there was
/// a trap here: `cover_kind` and `cover_image_path` came across in the `INSERT … SELECT` like
/// everything else, which left the copy claiming `custom` with no `<newId>.webp` behind it and
/// a path naming the *original's* file — so the bytes had to be copied too, best-effort,
/// falling back to `card_art` when they could not be. Custom covers went on 2026-08-31 and the
/// whole apparatus went with them. **`cover_image_path` is no longer named in the statement
/// below** — it is retired, phase one is to stop writing it, and a copy is a write.
///
/// **`default_category_id` is the one column that comes across *remapped* rather than copied**,
/// and it is why the `INSERT … SELECT` below does not name it: it holds a `deck_categories.id`,
/// and the copy's categories do not exist yet at that statement. The copy is born on
/// [`AUTO_CATEGORY`] and pointed at its own pile once the map is built.
///
/// **Categories and labels are new rows with new ids**, and the cards are remapped onto them.
/// This is the part a "copy the cards" implementation gets wrong invisibly: `deck_cards`
/// stores a `category_id`, so copying a card row verbatim would file the copy's card under
/// the *original's* category — and then deleting the original would take the copy's cards
/// with it through `ON DELETE CASCADE`. Two id maps, built as the rows are written, are what
/// keep the copy a copy. `label_id` maps the same way and falls back to NULL, which cannot
/// happen (a card's label is a label of its own deck) but is the honest answer if it ever does.
///
/// The copy is **not** handed [`crate::deck_meta::ensure_predefined_categories`]: it inherits
/// the source's four, because every deck has them — the v8 migration backfilled every deck
/// that predates it and [`create_deck`] seeds every one made since. Topping up afterwards
/// would be a second write with a failure mode of its own (a user category named "Sideboard"
/// collides with the seeded one on `DECK_CATEGORY_GRAIN`) in exchange for an invariant that
/// already holds.
pub fn duplicate_deck(conn: &Connection, id: i64) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let copy: Option<(i64, String)> = tx
        .query_row(
            "INSERT INTO decks (name, format_key, description, cover_kind, cover_card_id,
                                folder_id, notes, theory_enabled,
                                separate_x_group, bracket, archived, created_at, updated_at)
             SELECT name || ' (copy)', format_key, description, cover_kind, cover_card_id,
                    folder_id, notes, theory_enabled, separate_x_group,
                    bracket, 0, unixepoch(), unixepoch()
               FROM decks WHERE id = ?1
             RETURNING id, name",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((copy, copy_name)) = copy else {
        return Err(GONE.to_owned());
    };
    create_deck_group(&tx, copy, &copy_name)?;
    // **Its own group, and empty** — see this function's doc. Named after the copy, which is the
    // original's name plus ` (copy)`, so the folder tree and the gallery agree about what this
    // deck is called from its first moment.

    // Read then write, one row at a time with `RETURNING id`, rather than one
    // `INSERT … SELECT`: the map from old id to new is the whole point, and a set insert
    // answers no ordered list of ids to build one from.
    let categories: Vec<(i64, String, String, bool, i64, String)> = tx
        .prepare(
            "SELECT id, name, kind, is_active, sort_order, origin FROM deck_categories
              WHERE deck_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut category_map: HashMap<i64, i64> = HashMap::new();
    for (old, name, kind, is_active, sort_order, origin) in categories {
        // **`origin` is copied rather than re-decided**, and it is the fourth write site of a
        // column with only four ([`crate::deck_meta::DeckCategoryRow::origin`]). Duplicating a
        // deck copies its piles; it does not *make* them, so a pile the app invented stays
        // `'auto'` and one the reader made stays `'user'`. Defaulting the copy to `'user'`
        // would quietly give the duplicate a different shape from its original — every auto
        // pile in it drawing empty — and letting this INSERT fall through to the column's
        // DEFAULT is exactly how that would happen.
        let new: i64 = tx
            .query_row(
                "INSERT INTO deck_categories
                    (deck_id, name, kind, is_active, sort_order, origin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch())
                 RETURNING id",
                params![copy, name, kind, is_active, sort_order, origin],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        category_map.insert(old, new);
    }

    // **The default pile is remapped, not copied** — and it is the one `decks` column the
    // `INSERT … SELECT` above deliberately leaves at its own DEFAULT for that reason. It holds a
    // `deck_categories.id`, and the copy's piles are the new rows just written, so carrying the
    // number across verbatim would point the duplicate at a pile of the *original* — the exact
    // failure the two id maps exist to prevent for `deck_cards`, and a quieter one here, because
    // nothing would break: adds would simply file into a column the reader is not looking at.
    //
    // `AUTO_CATEGORY` is the answer for a source that was already on Auto (it is in no map, and
    // it is what the copy was born with) and for a source pointing at a pile that has gone,
    // which the clean-up in [`crate::deck_meta::delete_category`] means cannot happen and which
    // is the honest answer if it ever does — `label_id`'s fallback below, for its reason.
    let source_default: i64 = tx
        .query_row(
            "SELECT default_category_id FROM decks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if let Some(mapped) = category_map.get(&source_default) {
        tx.execute(
            "UPDATE decks SET default_category_id = ?2 WHERE id = ?1",
            params![copy, mapped],
        )
        .map_err(|e| e.to_string())?;
    }

    // **The labels are not copied, and since schema v21 there is nothing to copy.** A duplicate
    // used to get its own `deck_labels` rows and a map from the original's ids to them, because a
    // label belonged to a deck and the copy needed its own. A label is one app-wide row now, so the
    // copied cards keep the very `label_id` they had: the duplicate wears the same labels as its
    // original, which is what a reader duplicating a deck means by "the same deck".

    // `needs_review` travels with the row: the sentence says this printing left the card
    // database, which is just as true of the copy.
    let cards: Vec<CopiedCard> = tx
        .prepare(
            "SELECT category_id, label_id, variant, card_id, set_code, collector_number, lang,
                    name, quantity, needs_review, finish
               FROM deck_cards WHERE deck_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![id], |r| {
            Ok(CopiedCard {
                category_id: r.get(0)?,
                label_id: r.get(1)?,
                variant: r.get(2)?,
                card_id: r.get(3)?,
                set_code: r.get(4)?,
                collector_number: r.get(5)?,
                lang: r.get(6)?,
                name: r.get(7)?,
                quantity: r.get(8)?,
                needs_review: r.get(9)?,
                // **Copied, like the pile's `origin` two functions up and for its reason**: a
                // duplicate has the same shape as its original, so a deck of foils duplicated
                // is a deck of foils. Left out, the copy would be a deck of regular cards with
                // a different total, silently.
                finish: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for card in cards {
        tx.execute(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, label_id, quantity, needs_review, finish, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12, unixepoch(), unixepoch())",
            params![
                copy,
                category_map.get(&card.category_id),
                card.variant,
                card.card_id,
                card.set_code,
                card.collector_number,
                card.lang,
                card.name,
                // Verbatim: the label is the app's, so the copy wears the very same row.
                card.label_id,
                card.quantity,
                card.needs_review,
                card.finish,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    // **The copy's history, not the original's, and one line rather than one per card.** The
    // copy is a new deck and its history begins the way [`create_deck`]'s does; the cards it
    // arrived with are not edits anyone made to it, and N `add` rows for one press would read
    // as a deck someone typed out. The original is untouched and records nothing at all — it
    // was not changed.
    crate::deck_audit::record(
        &tx,
        copy,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &json!({ "field": "name", "from": null, "to": copy_name }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, copy)?.ok_or_else(|| GONE.to_owned())
}

/// The gallery, archived decks last and most recently touched first.
pub fn list_decks(conn: &Connection) -> Result<Vec<DeckRow>, String> {
    let sql = format!(
        "{} ORDER BY d.archived ASC, d.updated_at DESC, d.id DESC",
        *DECK_SELECT
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], deck_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Add copies to a category, folding on the grain — the drag-in and the click-to-add write.
///
/// **Either `category_id` or `category_name`**, and at least one ([`NO_CATEGORY`]). An
/// explicit id is a drop onto a column the user pointed at; a name is the add path's "file it
/// where this card belongs", found-or-created through
/// [`crate::deck_meta::category_for_name`] — the word itself is computed in TypeScript
/// (`autoCategoryFor`), because which pile a Sol Ring belongs in is domain logic and this
/// module is plumbing. When both arrive the id wins: it is the more specific instruction, and
/// it is the one a drag carries.
///
/// **`finish` is part of the address, not a column to overwrite.** It joins the grain at schema
/// v18, so an add of the foil copy folds into the pile's foil row and leaves its regular row
/// alone. `None` is the regular copy; [`normalise_finish`] is the fence.
// Eight, and every one of them is a column of `DECK_CARD_GRAIN` or a value written at it. The
// obvious cure — a struct — would be a shape nothing else in this module has, for a function
// whose whole job is to name one row of one table.
#[allow(clippy::too_many_arguments)]
pub fn add_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: Option<i64>,
    category_name: Option<&str>,
    variant: &str,
    finish: Option<&str>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let finish = normalise_finish(finish)?;
    // Not `valid_quantity`: *adding* zero copies is a no-op dressed as a write, and would
    // conjure a row out of nothing. The same refusal `collection::add_entry` gives, from the
    // one constant that owns the sentence.
    if quantity <= 0 {
        return Err(ZERO_ADD.to_owned());
    }
    if category_id.is_none() && category_name.is_none() {
        return Err(NO_CATEGORY.to_owned());
    }
    let (set_code, collector_number, lang, name) = printing_of(conn, card_id)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // Read before the resolution below, because that resolution is what can *create* a pile:
    // the diff against this is how an undo knows to take an invented `Ramp` column away again
    // along with the card that made it.
    let categories_before = crate::deck_undo::category_ids(&tx, deck_id)?;
    // Inside the transaction because the name arm *writes*: a category nobody has made yet is
    // made here, and it must not survive a card insert that fails after it.
    //
    // Both arms answer the category's **name** as well as its id, because the history row
    // below names the pile the card went into and a number nobody chose says nothing. The id
    // arm gets it free from the fence it runs anyway; the name arm trims the caller's string
    // the way `category_for_name` did before storing it, so the two arms record the same word
    // for the same category.
    let (category_id, category) = match category_id {
        Some(id) => (id, category_of_deck(&tx, deck_id, id)?),
        // Unreachable past the guard above, and written as a second refusal rather than an
        // `expect` so that an edit which ever drops that guard answers the sentence instead
        // of panicking in a user's face.
        None => {
            let Some(name) = category_name else {
                return Err(NO_CATEGORY.to_owned());
            };
            (
                crate::deck_meta::category_for_name(&tx, deck_id, name)?,
                name.trim().to_owned(),
            )
        }
    };
    // The cell this add is about, read before the INSERT. **The fold is why this is a read
    // rather than "the row was not there"**: an add onto a category that already holds the
    // printing takes it from 2 to 3, so undoing means putting 2 back rather than deleting.
    let cells = vec![crate::deck_undo::Cell::card(variant, category_id, card_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    // The conflict target is `DECK_CARD_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint" at the first quick-add, which is why it is a
    // constant. The quantities add; `label_id` and `needs_review` are left alone, because the
    // row that is already there is the one the user labelled.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             finish, quantity, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING id, quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let (id, landed): (i64, i64) = tx
        .query_row(
            &sql,
            params![
                deck_id,
                category_id,
                variant,
                card_id,
                set_code,
                collector_number,
                lang,
                name,
                finish,
                quantity
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    // The copies **added**, never the total the row landed on: the history is a list of
    // changes, and `delta` is what the day header adds up. A fold that took a row from 2 to 3
    // is one copy of history, not three.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::ADD,
        Some((card_id, &name)),
        &json!({ "category": category, "quantity": quantity }),
        quantity,
    )?;
    crate::deck_undo::record_cells(
        &tx,
        audit_id,
        deck_id,
        cells,
        before,
        Some(categories_before),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: landed,
        removed: false,
    })
}

/// Set an absolute quantity — the stepper write. **Zero removes the row.**
///
/// The wishlist's asymmetry, for the wishlist's reason: `deck_cards.quantity` carries
/// `CHECK (quantity > 0)`, and a category slot at zero holds nothing worth keeping. The
/// collection keeps its zeros because it has a condition, a price and an acquisition story
/// to keep; a deck slot has an intention and nothing else, and an intention the user
/// stepped down to none of is a withdrawn intention.
///
/// A negative number is refused through the one [`valid_quantity`], and the refusal matters
/// more here rather than less: in a module where zero legitimately deletes, treating `-1` as
/// close enough to zero would let arithmetic that went wrong upstream destroy a row.
pub fn set_card_quantity(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: i64,
    variant: &str,
    finish: Option<&str>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let finish = normalise_finish(finish)?;
    valid_quantity(quantity, "deck quantity")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    let category = category_of_deck(&tx, deck_id, category_id)?;

    // The row as it is now, read before either branch writes. The history needs all three
    // columns — the count it is moving *from*, and the name the line will be read by once the
    // row is gone — and reading them once here is also what lets the `quantity` branch report
    // both numbers, which `RETURNING` cannot: SQLite's `RETURNING` on an UPDATE answers the
    // **new** row, so the old value is unrecoverable a statement later.
    //
    // **`coalesce(finish, '') = coalesce(?5, '')` rather than `finish IS ?5`**, so that this
    // WHERE is the same test `DECK_CARD_GRAIN`'s index is built on and the two can never mean
    // different things. Since v18 a pile can hold the regular copy and the foil as two rows,
    // and a stepper aimed at one must not find the other.
    let current: Option<(i64, i64, String)> = tx
        .query_row(
            "SELECT id, quantity, name FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, card_id, category_id, variant, finish],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    // Read whole rather than rebuilt from `current`: the step has to put the **label** and any
    // `needs_review` sentence back too, and a delete takes all of it. `current` answers what
    // the history line needs and is deliberately not widened to answer both questions.
    let cells = vec![crate::deck_undo::Cell::card(variant, category_id, card_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;

    if quantity == 0 {
        if let Some((_, was, name)) = &current {
            tx.execute(
                "DELETE FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
                    AND coalesce(finish, '') = coalesce(?5, '')",
                params![deck_id, card_id, category_id, variant, finish],
            )
            .map_err(|e| e.to_string())?;
            // `reason` is null and stays null from here: the reconciler is the only writer
            // that could ever have one to give, and it does not delete — it flags. The key is
            // in the shape so a later caller that *does* remove a card for a stated reason has
            // somewhere to put it, rather than a second payload shape for one kind.
            let audit_id = crate::deck_audit::record(
                &tx,
                deck_id,
                variant,
                crate::deck_audit::REMOVE,
                Some((card_id, name)),
                &json!({ "category": category, "quantity": was, "reason": null }),
                -was,
            )?;
            crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
        }
        // Nothing else in this arm records a step: a stepper that lands on an already-empty
        // slot removed nothing and wrote no history row, so there is nothing to reverse.
        // A stepper that lands on a slot already empty removed nothing, so it records nothing:
        // this is the one place the "every write records a row" rule gives way, and it gives
        // way to the truth. A `remove` of zero copies would be a history of a change that
        // never happened.
        tx.commit().map_err(|e| e.to_string())?;
        // A slot the caller wanted empty and that is empty: like `remove_entry`, a delete
        // that finds nothing already has what it wanted. There is no row left to name, so
        // the id is 0 — the only thing this path reports is that the slot is gone.
        return Ok(EntryChange {
            id: current.map_or(0, |(id, ..)| id),
            quantity: 0,
            removed: true,
        });
    }

    // The [`crate::collection::GONE`] asymmetry: an *adjustment* to a row that is not there
    // could not do what it was asked. Putting a card into a category is [`add_card`].
    let (id, was, name) = current.ok_or_else(|| card_gone(&category))?;
    tx.execute(
        "UPDATE deck_cards SET quantity = ?6, updated_at = unixepoch()
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
            AND coalesce(finish, '') = coalesce(?5, '')",
        params![deck_id, card_id, category_id, variant, finish, quantity],
    )
    .map_err(|e| e.to_string())?;
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::QUANTITY,
        Some((card_id, &name)),
        &json!({ "category": category, "from": was, "to": quantity }),
        quantity - was,
    )?;
    crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Empty one category of one variant — the pile's right-click `Clear stack`.
///
/// ## Why this is a command and not a loop over [`set_card_quantity`]
///
/// The frontend already holds every row of the pile, so stepping each to zero would work — and
/// would be a transaction, a move across the deck boundary and a `["decks"]` invalidation **per
/// card**, which on a forty-card pile is forty of each. That is the same arithmetic that made
/// [`crate::import::commit_import`] a command rather than a loop over `add_card`, and the
/// answer is the same: one transaction, one history row.
///
/// ## Scope: this variant, and deliberately not both
///
/// The opposite of [`crate::deck_meta::delete_category`], which takes the live list and the
/// theory list together because `deck_cards.category_id` is `ON DELETE CASCADE` and a category
/// is not variant-scoped. A clear is not a delete: the pile survives, and what a reader is
/// pointing at when they clear a stack is the list on screen. So the `WHERE` carries `variant`
/// like every other card command, and the confirmation says out loud that the other list is
/// untouched.
///
/// ## An empty pile writes nothing
///
/// Not merely an optimisation — [`set_card_quantity`]'s zero arm makes the same choice for the
/// same reason, and states it: a `remove` row of zero copies is a history of a change that never
/// happened. So no `touch_deck`, no audit row and nothing moved in the collection, and the
/// deck's `updated_at` does not move because somebody opened a menu on an empty column. The UI
/// greys the row in that state; this is the fence behind it, since a pile can empty under an
/// open menu.
///
/// ## The copies come back
///
/// A `deck_cards` row is an intention; a row in the deck's **group** is a card the reader
/// physically owns, and clearing a pile does not stop them owning it. So every copy the group
/// holds for a `live` row of this pile is filed into `Recently removed` first, through
/// [`release_live_copies`] — the same act [`crate::collection_alloc::deck_to_collection`]
/// performs one card at a time, in bulk. Left undone, the copies would stay filed under a deck
/// that has never heard of them: invisible, and unavailable to every other deck for ever.
///
/// **The `theory` variant moves nothing**, and not as an optimisation: a plan holds no cards, so
/// there is nothing in any folder behind a theory row —
/// [`crate::collection_alloc::THEORY_HOLDS_NOTHING`], which is a refusal there and simply an
/// empty loop here.
///
/// **Undo puts the list back and not the custody.** [`crate::deck_undo`] restores `deck_cards`
/// cells; the copies have gone to `Recently removed` and stay there, so an undone clear reads
/// with its owned counts at zero until the reader files them again. That is exactly where a cut
/// card leaves them — [`crate::collection_alloc::deck_to_collection`] records no step at all —
/// and teaching the journal about collection rows is a change to what a step *is*.
///
/// Answers the copies removed — **copies, not rows**, which is what the confirmation counted and
/// what `delta` means in the history. It counts `deck_cards`, never the copies that moved: the
/// two can differ where the group holds fewer copies than the list claims, and what the reader
/// is told they cleared is what left the deck.
pub fn clear_category(
    conn: &Connection,
    deck_id: i64,
    category_id: i64,
    variant: &str,
) -> Result<i64, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The fence before the count, as every card command opens: a category of *another* deck
    // must not be counted, let alone emptied, and nothing in the DDL says so.
    let category = category_of_deck(&tx, deck_id, category_id)?;
    // Summed **before** the delete, and in copies rather than rows — two printings at 2 and 3
    // is 5 cards, which is the number the confirmation quoted and the number the day header
    // adds up. `delete_category` counts the same way one module over.
    let cleared: i64 = tx
        .query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND category_id = ?2 AND variant = ?3",
            params![deck_id, category_id, variant],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if cleared == 0 {
        return Ok(0);
    }
    // One wide cell — the whole pile of the one variant, which is exactly what the DELETE
    // below takes and exactly what an undo has to put back. `cleared` is copies and cannot
    // rebuild the rows; this is the only record of what was in the pile.
    let cells = vec![crate::deck_undo::Cell::pile(variant, category_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    // **This pile and no other**, which is the whole of what this site adds: `Some(category_id)`
    // is the scope the DELETE below takes, and `release_live_copies` owns everything else about
    // the release — the `live` fence included, so `theory` is a loop that never runs here.
    release_live_copies(&tx, deck_id, variant, Some(category_id))?;
    tx.execute(
        "DELETE FROM deck_cards WHERE deck_id = ?1 AND category_id = ?2 AND variant = ?3",
        params![deck_id, category_id, variant],
    )
    .map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // `REMOVE` with **no card**, which is `commit_import`'s replace row exactly: the event is
    // about a pile rather than about a printing, and there is no one name to file it under.
    // `action` is what tells the two apart in `auditText.ts` — that renderer reads a bare
    // `remove` as "Removed n × a card", which is a sentence about a card this row does not have.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::REMOVE,
        None,
        &json!({ "action": "clear", "category": category, "cards": cleared }),
        -cleared,
    )?;
    crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(cleared)
}

/// Empty a whole list — Deck settings' `Clear live list…`/`Clear theory list…`, which is
/// [`clear_category`] one scope
/// out (issue #281).
///
/// ## Why this is a command and not a loop over [`clear_category`]
///
/// The editor already knows every pile on screen, so clearing them one at a time would work —
/// and would be a transaction, a walk across the deck boundary, a `["decks"]` invalidation and
/// a **history row** per pile, which on a nine-column Commander deck is nine of each and nine
/// lines under one day header for one press. That is [`clear_category`]'s own arithmetic at the
/// next scope up, and the answer is the one [`crate::import::commit_import`] reached: one
/// transaction, one invalidation, one line of history for one press.
///
/// ## Scope: this variant, and deliberately not both
///
/// [`clear_category`]'s rule, unchanged by dropping the category from the `WHERE`. What a
/// reader is pointing at when they empty a deck is the list in front of them, so the live list
/// and the theory list go one press at a time and the confirmation says which one went. **The
/// piles themselves survive**: a clear is not [`crate::deck_meta::delete_category`], and a
/// reader emptying a deck to build it again keeps the columns they built it in.
///
/// ## The two things a later reader will get wrong
///
/// **The answer is copies, never rows.** Two printings at 2 and 3 is `5` — the number the
/// confirmation quoted and the number `delta` means in the history. How many `deck_cards` rows
/// the DELETE took is not a number anybody is shown, and the two differ the moment a deck holds
/// a printing twice.
///
/// **The live release is what keeps a cleared deck's cards findable.** A `deck_cards` row is an
/// intention; a row in the deck's **group** is a card the reader physically owns, and emptying
/// the list does not stop them owning it. So every copy the group holds behind a `live` row is
/// filed into `Recently removed` first, through [`release_live_copies`] — the same act
/// [`crate::collection_alloc::deck_to_collection`] performs one card at a time. Left undone,
/// clearing a deck would leave *every* copy of it filed under a deck that has never heard of
/// them: invisible on the Collection page, unavailable to every other deck, and with nothing
/// anywhere to say where they went. **`theory` releases nothing**, and not as an optimisation —
/// a plan holds no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so the loop simply
/// never runs.
///
/// ## An empty list writes nothing
///
/// [`clear_category`]'s early return, for its reason: a `remove` row of zero copies is a history
/// of a change that never happened, so no `touch_deck`, no audit row and no undo step.
/// `commit_import`'s replace mode makes the same call in the same words — a replace that found
/// nothing to clear writes no `remove` row at all.
///
/// **Undo puts the list back and not the custody** — [`clear_category`]'s note at this scope:
/// the copies have gone to `Recently removed` and stay there, so an undone clear reads with its
/// owned counts at zero until the reader files them again.
pub fn clear_variant(conn: &Connection, deck_id: i64, variant: &str) -> Result<i64, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // **No `category_of_deck` fence**, which is not an omission: this command takes no category
    // to check, and `deck_id` is the whole scope. Every row it can reach belongs to the deck the
    // caller named by construction.
    //
    // Summed **before** the delete, and in copies rather than rows — [`clear_category`]'s count,
    // one scope out.
    let cleared: i64 = tx
        .query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2",
            params![deck_id, variant],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if cleared == 0 {
        return Ok(0);
    }
    // One wide cell per pile that actually holds something — [`clear_category`]'s single cell,
    // as many times as there are columns with cards in them. `cleared` is copies and cannot
    // rebuild a row; these are the only record of what the list contained.
    //
    // **Not `read_variant`**, which is the other shape in that module and would answer the same
    // rows here: it pairs with `record_variant`'s `Op::Variant`, and a step whose "before" was
    // read over one scope and whose "after" is read over another is a pair that does not
    // reverse. `record_cells` reads its own "after" through `read_cells` over these very cells,
    // so these cells are what the "before" has to come from.
    let piles: Vec<i64> = tx
        .prepare(
            "SELECT DISTINCT category_id FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2
              ORDER BY category_id",
        )
        .and_then(|mut s| {
            s.query_map(params![deck_id, variant], |r| r.get(0))?
                .collect()
        })
        .map_err(|e| e.to_string())?;
    let cells: Vec<crate::deck_undo::Cell> = piles
        .into_iter()
        .map(|category_id| crate::deck_undo::Cell::pile(variant, category_id))
        .collect();
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    // **The whole list**, which `None` says — [`clear_category`]'s call with the one argument
    // that differs between the two scopes, exactly as the DELETE below is its DELETE with
    // `category_id` dropped from the `WHERE`.
    release_live_copies(&tx, deck_id, variant, None)?;
    tx.execute(
        "DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2",
        params![deck_id, variant],
    )
    .map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // `REMOVE` with **no card**, [`clear_category`]'s row with one field moved: `scope` is what
    // tells `auditText.ts` this line is about a whole list rather than one pile, and there is no
    // `category` because there was no category — a clear of the deck names none, and a renderer
    // that read a missing name as a pile called `undefined` is exactly what the field prevents.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::REMOVE,
        None,
        &json!({ "action": "clear", "scope": "deck", "cards": cleared }),
        -cleared,
    )?;
    crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(cleared)
}

/// Move every copy from one category to another, in one transaction, folding into the row the
/// target category already holds. **Within one variant**: a move is a re-filing, never a
/// promotion of a theory row into the live deck.
///
/// The identity travels **from the moved row**, never from a fresh `cards` lookup: a deck
/// whose printing left the card database is exactly the deck whose scratchpad someone is
/// tidying, and a move that needed the id to resolve would refuse the one row that most
/// needs moving.
///
/// `label_id` travels with it too, where the printing does — a label is the user's word about
/// *this card in this deck*, and re-filing it is not a reason to lose it.
///
/// **Either `to_category_id` or `to_category_name`**, and at least one ([`NO_CATEGORY`]) —
/// [`add_card`]'s two-arm target, copied deliberately rather than approximated, because the two
/// commands are answering the same question about the same table. An explicit id is a drop onto
/// a column the reader pointed at; a name is the quick zones' `Auto`, found-or-created through
/// [`crate::deck_meta::category_for_name`], with the word itself computed in TypeScript
/// (`autoCategoryFor`) because which pile a Sol Ring belongs in is domain logic and this module
/// is plumbing. When both arrive the id wins, for `add_card`'s reason: it is the more specific
/// instruction.
///
/// **The name arm is why this resolves inside the transaction and why `from == to` is checked
/// after it and not before.** A refile whose target does not exist yet *writes* — the category
/// is made here — and a card whose rule names the pile it is already in has to be answered
/// `Ok`, not moved; neither is knowable until the name has been resolved.
///
/// Answers the id of the category the copies are now in, which for the name arm is the only way
/// a caller learns what was found or made. The caret follows a moved card to its new pile, so
/// that id is not a convenience.
// [`add_card`]'s reason, one command over.
#[allow(clippy::too_many_arguments)]
pub fn move_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    from_category_id: i64,
    to_category_id: Option<i64>,
    to_category_name: Option<&str>,
    variant: &str,
    finish: Option<&str>,
) -> Result<i64, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    // Addresses the row; **never written**. Moving the foil copy to another pile leaves it the
    // foil copy — the reader moved a card, they did not change what it is.
    let finish = normalise_finish(finish)?;
    if to_category_id.is_none() && to_category_name.is_none() {
        return Err(NO_CATEGORY.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // Read before the resolution below, because that resolution is what can **create** a pile
    // — `add_card`'s rule, and this command grew the same second arm. Undoing a move that
    // invented a `Ramp` column has to take the column away with the card that made it.
    let categories_before = crate::deck_undo::category_ids(&tx, deck_id)?;
    let from = category_of_deck(&tx, deck_id, from_category_id)?;
    let (to_category_id, to) = match to_category_id {
        Some(id) => (id, category_of_deck(&tx, deck_id, id)?),
        // Unreachable past the guard above, and written as a second refusal rather than an
        // `expect` for `add_card`'s reason: an edit that ever drops that guard answers the
        // sentence instead of panicking in a reader's face.
        None => {
            let Some(name) = to_category_name else {
                return Err(NO_CATEGORY.to_owned());
            };
            (
                crate::deck_meta::category_for_name(&tx, deck_id, name)?,
                name.trim().to_owned(),
            )
        }
    };
    // **After the resolution, because the name arm cannot answer before it.** A card the rule
    // files where it already is is not an error and is not a move: the caller is told which
    // pile that was, and this returns **without committing**, so the `touch_deck` above is
    // rolled back with the transaction. Bumping `updated_at` to leave the list exactly as it
    // was is the thing the id arm's caller-side guard exists to prevent, and a second entrance
    // must not reintroduce it.
    //
    // Nothing can have been created on this path: `category_for_name` answers a **new** id when
    // it makes a pile, and a new id is never a pile the card is already in.
    if from_category_id == to_category_id {
        return Ok(to_category_id);
    }
    // The moved row's own denormalized name, read before the move folds it into whatever the
    // target already held — and it is the row's name rather than a fresh `cards` lookup for
    // the reason the identity below travels from the row: an orphan is exactly the card most
    // likely to be getting tidied, and it has no `cards` row left to be named by.
    //
    // This read is also the "is there a row to move" fence, which used to be the `INSERT`'s own
    // affected-row count. Same `WHERE`, same answer, one statement earlier — and earlier is
    // where it belongs, because the alternative is running an INSERT … SELECT that is known to
    // select nothing before discovering it.
    let moved_name: String = tx
        .query_row(
            "SELECT name FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, card_id, from_category_id, variant, finish],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| card_gone(&from))?;
    // **Both** cells, because a move is two changes to one variant and the target's fold is
    // the half that is not obvious: moving onto a category that already holds the printing
    // takes that row from 2 to 3, so undoing means putting the 2 back rather than deleting a
    // row the reader put there separately.
    let cells = vec![
        crate::deck_undo::Cell::card(variant, from_category_id, card_id),
        crate::deck_undo::Cell::card(variant, to_category_id, card_id),
    ];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    // `INSERT … SELECT … ON CONFLICT` over the same table: the `WHERE` is what makes it
    // unambiguous to parse, and it is here anyway. `needs_review` comes across with a row
    // that lands in an empty category and is left alone where the target row already exists —
    // the fold's rule in `reconcile::fold_deck_card_into_existing`, for its reason.
    //
    // **`finish` is selected across**, so the row lands in the new pile as whatever object it
    // was — and the fold above it is on the five-column grain, so a foil copy moved onto a pile
    // holding the regular one is two rows there rather than one wrong one.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             label_id, finish, quantity, needs_review, created_at, updated_at)
         SELECT deck_id, ?3, variant, card_id, set_code, collector_number, lang, name,
                label_id, finish, quantity, needs_review, unixepoch(), unixepoch()
           FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?4 AND variant = ?5
            AND coalesce(finish, '') = coalesce(?6, '')
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    tx.execute(
        &sql,
        params![
            deck_id,
            card_id,
            to_category_id,
            from_category_id,
            variant,
            finish
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
            AND coalesce(finish, '') = coalesce(?5, '')",
        params![deck_id, card_id, from_category_id, variant, finish],
    )
    .map_err(|e| e.to_string())?;
    // `delta` 0: a move changes no count. The copies are in the deck before and after, and a
    // day roll-up that charged them twice would report a tidy-up as a shopping trip.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::MOVE,
        Some((card_id, &moved_name)),
        &json!({ "from": from, "to": to }),
        0,
    )?;
    crate::deck_undo::record_cells(
        &tx,
        audit_id,
        deck_id,
        cells,
        before,
        Some(categories_before),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(to_category_id)
}

/// What a swap answers: where the copies ended up, and whether they had company.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    /// The target category already held that printing, so the two rows became one. The UI
    /// says so, because a deck list that silently loses a line reads like a bug.
    pub folded: bool,
    /// The quantity of the row the copies now live in — the **sum**, when `folded`.
    pub quantity: i64,
}

/// Swap a deck card to another printing of the same card: same category, same variant, same
/// copies, folding into whatever that category already holds of the printing swapped to.
///
/// The card pane's "Use this printing", and the one card write whose identity comes from a
/// **fresh `cards` lookup** rather than from the row being changed ([`move_card`]'s comment
/// is the other half of that thought). The reason is the direction of travel: a move keeps a
/// printing the user already chose, while a swap is the user choosing a new one — off a list
/// that was read out of `cards` a second ago. So an id that does not resolve is not an
/// orphan to be preserved, it is a sync that raced the click ([`PRINTING_GONE`]).
///
/// "Of the same card" is **enforced** rather than assumed: the two ids' `oracle_id`s are
/// compared and a mismatch is refused ([`not_the_same_card`]), because every statement below
/// would carry the quantity onto whatever it is handed. The pair that cannot be compared — a
/// `from` printing that has left `cards` — is allowed through; see the guard's comment. It is
/// not the only way to be uncomparable, and the doc would be flattering the guard to stop
/// there: [`oracle_of`] answers `None` for a NULL `oracle_id` as much as for a missing row, so
/// a null on *either* side skips the comparison — and a null on the **to** side would let an
/// unverified cross-card write through, where the `from` side's is the deliberate case above.
/// That is a fence around a nullable column rather than a card anyone can reach: `oracle_id` is
/// NULLABLE and no live row is null, 0 of 116 590 including all 81 reversible printings,
/// because `card_row` falls back to `card_faces[0]`.
///
/// `needs_review` is deliberately **not** carried across. The flag says the row's printing
/// left the card database, and a swap onto a printing that is in it is exactly the cure —
/// the new row is written clean. A fold leaves the target row's flag alone, [`add_card`]'s
/// rule and the reconciler's.
///
/// One transaction, for the reason [`update_deck`]'s is one: mid-swap the copies are in
/// neither row, or in both, and neither is a state a reader may see.
pub fn swap_printing(
    conn: &Connection,
    deck_id: i64,
    from_card_id: &str,
    to_card_id: &str,
    category_id: i64,
    variant: &str,
    finish: Option<&str>,
) -> Result<SwapResult, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    // **Addresses both ends and is carried across**: the reader is changing which printing the
    // deck plays, not which object it is, so the foil copy of the old printing becomes the foil
    // copy of the new one. It is deliberately *not* checked against the new printing's
    // `finishes` — a swap onto a printing sold in no foil would then be refused outright, where
    // what a reader wants is the printing they picked. [`set_card_finish`] is where the finish
    // is the subject, and that is where the check belongs.
    let finish = normalise_finish(finish)?;
    // Before the transaction, so a no-op does not move `updated_at` and resort the gallery.
    if from_card_id == to_card_id {
        return Err(SAME_PRINTING.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    let category = category_of_deck(&tx, deck_id, category_id)?;

    // The name comes across with the quantity because a refusal below has to say what is in
    // the deck, and the row's own denormalized name is what the deck list is showing. The set
    // code comes across for the history: "swapped `lea` for `m10`" is the whole of what a
    // reader wants from this line, and the row about to be deleted is the only place the
    // *old* one is still written down.
    let (quantity, from_name, from_set): (i64, String, String) = tx
        .query_row(
            "SELECT quantity, name, set_code FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, from_card_id, category_id, variant, finish],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        // [`set_card_quantity`]'s asymmetry: a swap adjusts a row, and a row that is not in
        // that category is a stale editor. Putting a card into one is [`add_card`].
        .ok_or_else(|| card_gone(&category))?;

    let (set_code, collector_number, lang, name) =
        printing_row(&tx, to_card_id)?.ok_or_else(|| PRINTING_GONE.to_owned())?;

    // "Another printing of the same card" is this command's whole promise, and nothing below
    // enforces it: the insert carries the quantity onto whatever id it is handed, so a caller
    // that paired the wrong two would turn four Bolts into four Black Lotuses at the same
    // count, silently. Compared here rather than in the UI because the UI is exactly what
    // could be wrong.
    //
    // Both sides have to resolve for there to be a comparison. A **from** printing that is not
    // in `cards` is the deck's orphan row, and its oracle id is unknowable — refusing on
    // "cannot tell" would fence the copies onto a dead printing, which is the one row this
    // command most needs to be able to move (see the doc above: `needs_review` is not carried
    // across, because a swap is the cure).
    if let (Some(from_oracle), Some(to_oracle)) =
        (oracle_of(&tx, from_card_id)?, oracle_of(&tx, to_card_id)?)
    {
        if from_oracle != to_oracle {
            return Err(not_the_same_card(&from_name, &name));
        }
    }

    // **Both printings' cells, and this is the one that makes the fold reversible.** A swap
    // onto a printing the category already holds sums the two rows into one, and the history
    // records only that it `folded` — a boolean cannot say what the two quantities were. These
    // rows can, so undoing a fold splits it back into exactly the two rows it ate.
    let cells = vec![
        crate::deck_undo::Cell::card(variant, category_id, from_card_id),
        crate::deck_undo::Cell::card(variant, category_id, to_card_id),
    ];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;

    // [`add_card`]'s insert, grain and all — the same statement, because "put these copies
    // in that category" is the same write whether they came from a search or from another row.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             finish, quantity, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let landed: i64 = tx
        .query_row(
            &sql,
            params![
                deck_id,
                category_id,
                variant,
                to_card_id,
                set_code,
                collector_number,
                lang,
                name,
                finish,
                quantity
            ],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
            AND coalesce(finish, '') = coalesce(?5, '')",
        params![deck_id, from_card_id, category_id, variant, finish],
    )
    .map_err(|e| e.to_string())?;

    // `deck_cards.quantity` carries `CHECK (quantity > 0)`, so a row that was already there
    // contributed at least one copy: the landed total is strictly greater than what was moved
    // exactly when the insert folded. No second read needed to know it.
    let folded = landed > quantity;
    // `delta` 0 and the **new** printing's id: the deck holds the same number of the same card
    // and a different printing of it, so the line the history draws is about the row that
    // exists now. `folded` rides along because a deck list that silently loses a line reads
    // like a bug, and the history is the one place that can say it did not.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::SWAP,
        Some((to_card_id, &name)),
        &json!({
            "category": category,
            "fromSet": from_set,
            "toSet": set_code,
            "folded": folded,
        }),
        0,
    )?;
    crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SwapResult {
        folded,
        quantity: landed,
    })
}

/// Change which object a deck row plays: the regular copy, the foil, or the etched one.
///
/// **The same act as [`swap_printing`], one axis over** — the deck plays a different physical
/// object of the same card — so it answers the same [`SwapResult`], folds the same way, and
/// records the same `swap` audit kind rather than a tenth word. `AUDIT_KINDS` is
/// CHECK-constrained and SQLite has no `ALTER … CHECK`, so a new word would mean rebuilding
/// every reader's whole deck history for a spelling; `import::commit_import` met this
/// first and reused `add`/`remove` for the same reason.
///
/// **The fold is the half worth reading.** Setting the foil row of a pile that already holds a
/// regular row is two rows becoming one: the quantities add and the row that moved is deleted.
/// `label_id` and `needs_review` are the **surviving** row's — [`add_card`]'s rule, because the
/// row that was already there is the one the reader labelled.
///
/// Three refusals, each its own sentence: [`SAME_FINISH`] for a press that changes nothing,
/// [`FINISH_NOT_SOLD`] for a finish the printing does not come in, and [`GONE`] for a row that
/// is not in that pile.
pub fn set_card_finish(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: i64,
    variant: &str,
    from_finish: Option<&str>,
    to_finish: Option<&str>,
) -> Result<SwapResult, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let from = normalise_finish(from_finish)?;
    let to = normalise_finish(to_finish)?;
    // Before the transaction, so a no-op does not move `updated_at` and resort the gallery —
    // `swap_printing`'s fence, for its reason. Compared *after* normalising, so that `None` and
    // `Some("nonfoil")` are the one thing they are.
    if from == to {
        return Err(SAME_FINISH.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    let category = category_of_deck(&tx, deck_id, category_id)?;

    // What the printing is actually sold in. A finish the object does not come in is not a
    // choice the reader can make, whatever the menu happened to be drawing — and the menu
    // drawing it at all means the editor is stale, which is the same situation
    // `PRINTING_GONE` covers one command over.
    //
    // Only the **target** is checked. The finish being left may well be one the printing no
    // longer lists — a corpus can change under a stored row — and refusing to move off it
    // would strand the copies on exactly the value the reader is trying to correct.
    if let Some(want) = to.as_deref() {
        let sold: Option<String> = tx
            .query_row(
                "SELECT finishes FROM cards WHERE id = ?1",
                params![card_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let sold_here = sold
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
            .is_some_and(|list| list.iter().any(|f| f == want));
        if !sold_here {
            return Err(FINISH_NOT_SOLD.to_owned());
        }
    }

    // **One cell, and it names no finish** — which covers *both* rows of this printing in this
    // pile, deliberately. This write moves quantity between them, so a scope naming one would
    // restore half of what it read. See `deck_undo::Cell`.
    let cells = vec![crate::deck_undo::Cell::card(variant, category_id, card_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;

    let row: Option<(i64, i64, String)> = tx
        .query_row(
            "SELECT id, quantity, name FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, from],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // `set_card_quantity`'s asymmetry: an adjustment to a row that is not there could not do
    // what it was asked.
    let (from_id, moved, name) = row.ok_or_else(|| card_gone(&category))?;

    let landed: Option<(i64, i64)> = tx
        .query_row(
            "SELECT id, quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, to],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let (quantity, folded) = match landed {
        // Two rows become one. The target keeps its own id, its label and its sentence.
        Some((target_id, there)) => {
            tx.execute(
                "UPDATE deck_cards SET quantity = ?2, updated_at = unixepoch() WHERE id = ?1",
                params![target_id, there + moved],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM deck_cards WHERE id = ?1", params![from_id])
                .map_err(|e| e.to_string())?;
            (there + moved, true)
        }
        // Nothing to fold into: the row changes finish in place and keeps everything else.
        None => {
            tx.execute(
                "UPDATE deck_cards SET finish = ?2, updated_at = unixepoch() WHERE id = ?1",
                params![from_id, to],
            )
            .map_err(|e| e.to_string())?;
            (moved, false)
        }
    };

    // `delta` 0 and the `swap` kind: the deck holds the same number of the same card, in a
    // different object. `folded` rides along for `swap_printing`'s reason — a deck list that
    // silently loses a line reads like a bug, and the history is the one place that can say it
    // did not. The two finishes travel as the words the column stores, `null` for the regular
    // copy, and `auditText.ts` is what turns them into a sentence.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::SWAP,
        Some((card_id, &name)),
        &json!({
            "category": category,
            "fromFinish": from,
            "toFinish": to,
            "folded": folded,
        }),
        0,
    )?;
    crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SwapResult { folded, quantity })
}

// ---------------------------------------------------------------------------------------
// The read, and what is still missing
// ---------------------------------------------------------------------------------------

/// One card in one category of one deck: what it is, what the validation engine needs to
/// judge it, and how much of it the user actually has.
///
/// Three groups of columns, and the split is the design:
///
/// * **The row's own identity** (`name`, `set_code`, `collector_number`, `lang`) — copied
///   from `cards` at write time and `NOT NULL` ever since. A deck whose printing left the
///   card database still says what it is holding.
/// * **The card facts**, every one an `Option`: an orphaned row is still a card in the deck,
///   so the LEFT JOIN answers NULL rather than dropping the line — [`crate::collection`]'s
///   `FROM` discipline, for its reason.
/// * **The availability numbers**, computed at read time and stored on no row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardRow {
    pub id: i64,
    pub card_id: String,
    pub category_id: i64,
    /// The category's own name, as the user wrote it — what a column heading and every
    /// refusal about this row say. Denormalised into the read rather than looked up per row
    /// by the caller, because the editor draws it beside every line.
    pub category_name: String,
    /// `main` | `side` | `commander` | `companion` | `maybe` — **what the rules read**. The
    /// name is the user's and can be anything; the kind is the fixed word the validation
    /// engine sizes, counts copies and judges a commander by.
    pub category_kind: String,
    /// An inactive category counts toward nothing: not size, not copies, not legality, and
    /// [`attribute_owned`] hands it none of the copies the deck holds — so such a row always
    /// reads `owned_quantity` 0, by design and not because the user is short of it.
    pub category_active: bool,
    /// `live` | `theory` — which of the two decks this row belongs to. Every row in one read
    /// carries the same value (the read asks by variant), and it is here so a caller holding
    /// a row can write it back without remembering which list it came from.
    pub variant: String,
    /// The one label this row carries, or none. A label is per-deck data with a name and a
    /// palette colour, resolved here so a row can be drawn without a second lookup — and
    /// `None` on all three fields together, because a label deleted out from under a card sets
    /// `deck_cards.label_id` to NULL rather than deleting the card.
    pub label_id: Option<i64>,
    pub label_name: Option<String>,
    pub label_color: Option<String>,
    pub quantity: i64,
    pub name: String,
    pub set_code: String,
    /// The set's printed name, for the surfaces that show the three-letter code and have room
    /// to say what it stands for on hover — `PF26` is not a word anybody knows.
    ///
    /// **From `cards`, not from `deck_cards`, and so `None` for an orphan.** The code, the
    /// collector number and the card's name are denormalised onto the row precisely so a
    /// printing that has left the corpus is still listed and counted; a set *name* is not part
    /// of that promise, and inventing one for a card this build cannot find would be the only
    /// dishonest field on the row. A caller draws the code alone when this is `None`.
    pub set_name: Option<String>,
    pub collector_number: String,
    pub lang: String,
    pub needs_review: Option<String>,
    pub oracle_id: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    /// The card's colours as **concatenated letters** (`"WU"`), not a JSON array: that is
    /// what [`crate::card_row`] stores, so that is what is returned. Parsing it as JSON on
    /// the way out would be a second shape for one fact.
    pub colors: Option<String>,
    /// Scryfall's precomputed `color_identity`, in the same letter form. Precomputed is the
    /// point: it already folds in DFC backs, adventures, colour indicators and basic land
    /// types, so one subset check answers CR 903.5c and 903.5d together.
    pub color_identity: Option<String>,
    /// **This printing's** blob, not the oracle card's — the one thing that makes Old School
    /// come out right with no special case. `oldschool` is the only printing-sensitive
    /// legality key (Serra Angel is legal from `lea`, not from `8ed`), and a deck card names
    /// a printing, so each row's own blob answers the question the engine is asking.
    pub legalities: Option<String>,
    /// The printed power and toughness **as text**, because that is what they are: `"*"`,
    /// `"1+*"` and a printed `"0"` all ship in real data.
    ///
    /// Both NULL means *unknown*, never "no P/T box" — see [`fill_unknown_power_toughness`],
    /// which is what makes that true for a database that has not synced since schema v5.
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub layout: Option<String>,
    pub rarity: Option<String>,
    /// The `card_faces` array verbatim: per-face mana cost, MV and P/T live only here, and
    /// Tiny Leaders' per-face MV cap and DFC commander fronts both read them.
    pub faces: Option<String>,
    pub game_changer: Option<bool>,
    /// The finishes this printing **is sold in**, as the JSON array `cards.finishes` stores —
    /// a fact about the object, and the list a reader may pick [`DeckCardRow::finish`] from.
    ///
    /// It also answers the narrower question the art carries on its own: whether the printing
    /// leaves no choice at all, which is true of 12 366 foil-only and 892 etched-only paper
    /// printings. `None` for an orphan, whose card has left `cards`.
    pub finishes: Option<String>,
    /// JSON, verbatim: Scryfall's `promo_types`, the column the **kind** of foil lives in.
    ///
    /// [`Self::finishes`] says how shiny the object can be and [`DeckCardRow::finish`] which
    /// one this deck sleeves; neither can say *which* shiny, which is issue #160. Handed over
    /// unread — `src/lib/treatment.ts` owns the naming, and a deck view draws it from that
    /// stored finish rather than from the printing, so a plain copy of a Surge Foil printing
    /// is still drawn plain. `None` for an orphan, whose card has left `cards`.
    pub promo_types: Option<String>,
    /// Printed at uncommon on **any** printing of this oracle card. Computed, not read: a
    /// Pauper Commander commander is eligible for having been uncommon *somewhere*, and the
    /// `paupercommander` legality key answers a different question (the 99).
    pub ever_uncommon: bool,
    /// What one copy costs at the marketplace the read was given —
    /// [`crate::sorting::deck_card_price_expr`], which is two rules told apart by
    /// [`DeckCardRow::finish`].
    ///
    /// **A row that names a finish is quoted at that finish and no other.** No fallback: the
    /// reader has said which object is in the sleeve, and a foil row quoted at the nonfoil rate
    /// is a price nobody quoted.
    ///
    /// **A row that names none is quoted at the printing grain**, in whichever finish that
    /// marketplace sells it in: nonfoil where there is a nonfoil price, else foil, else etched.
    /// **The literal `'nonfoil'` this used to pass was a bug** — 13 515 foil-only and 892
    /// etched-only printings have no nonfoil price at any marketplace, so every one of them
    /// read `None` while the search wall quoted the same printing.
    ///
    /// Still never `cards.price_usd`, which is that chain precomputed for the search's `ORDER
    /// BY`: the numbers agree, and what a deck may not do is sum the display column.
    /// The euro etched hole is unchanged in both arms, because it lives in
    /// [`crate::sorting::price_expr`] — an etched printing is unpriced on Cardmarket.
    pub unit_price: Option<f64>,
    /// Which object this row plays: `None` is the regular copy, `Some("foil")` or
    /// `Some("etched")` the premium ones. Schema v18.
    ///
    /// **`None` is the only spelling of regular and `"nonfoil"` never appears here** —
    /// [`normalise_finish`] maps the word away at the command boundary and the column's CHECK
    /// makes any other path a hard error, because two spellings would be two rows on
    /// [`crate::schema::DECK_CARD_GRAIN`] that draw identically on screen and sum apart. It is
    /// the shape `soleFinish` already answers in on the TypeScript side, for the same reason:
    /// nonfoil is the finish a price is assumed to be.
    ///
    /// It is part of the row's **address**, not just its content — a foil copy and a regular
    /// copy of one printing in one pile are two rows, so every card command takes it.
    pub finish: Option<String>,
    /// Copies of this oracle card the allocator secured for this deck, attributed to this
    /// row in the read's own order (see [`read_deck_cards`]) and clamped to what each entry
    /// still holds — so a collection that shrank under a stored claim reads honestly.
    pub owned_quantity: i64,
    /// The front face's picture on `cards.scryfall.io`, by variant — **the only art a browser
    /// can reach**, and `None` when this printing has none worth fetching.
    ///
    /// [`crate::search::CardSummary::image_uris`] carries the argument in full: one variant
    /// ([`crate::image_uri::LIST_VARIANT`], which is what `DECK_CARD_VARIANT` is on the other
    /// side), face 0, the face-first precedence and the `soon.jpg` fence, every one of them
    /// [`crate::image_uri::front_face_map`]'s and none of them respelled here.
    ///
    /// **Two surfaces read it and both had to be wired**: `views/GridView` draws a
    /// `components/CardArt`, which takes the URL as a prop, and `CardStack` builds its own
    /// `<img>` src — so it is the one that has to put both candidates through `cardArtSrc`
    /// itself. `deck_get` is routed on web and `mtgimg://` is not reachable there.
    ///
    /// `None` for an orphan, whose printing has left `cards` — the same answer as every other
    /// card fact on this row, and the state `CardArt` already draws "No card" for.
    pub image_uris: Option<BTreeMap<String, String>>,
}

/// One deck and everything in it: the gallery's row, one variant's cards, and **every**
/// category and label the deck owns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail {
    pub deck: DeckRow,
    pub cards: Vec<DeckCardRow>,
    /// Every category of the deck, in `sort_order`, **never filtered by what is in it**: an
    /// empty category still draws a column (that is where the next card goes) and an inactive
    /// one always draws (that is the affordance for switching it back on). A category list
    /// narrowed to the categories that happen to hold cards would make an empty deck
    /// uneditable.
    ///
    /// Their `card_count` and both `total_price_*` are scoped to the same variant the cards
    /// are.
    pub categories: Vec<DeckCategoryRow>,
    /// Every label **this list is wearing**, most-used first — the fast row of the right-click
    /// menu, and nothing more than that.
    ///
    /// It was "every label of the deck, worn or not" until schema v21, when a label stopped being a
    /// deck's at all. There is no per-deck palette to send any more: what a deck has is cards,
    /// some of which wear a label, and that is what this is. Scoped to the same `variant` the
    /// cards are, because the live list and the theory list are treated as separate decks where
    /// labels are concerned — a menu opened over a theory row offers what the theory list wears.
    ///
    /// **The other labels are one command away and deliberately not here**: `deck_label_all` is the
    /// whole list, which the Labels dialog and the "Add label" dialog read and a context menu does
    /// not want. `deck_get` is the editor's one read and adding an app-wide table to it would
    /// make every deck open pay for a list that changes for reasons no deck knows about.
    pub labels: Vec<DeckLabelRow>,
}

/// One row of `format_specs` — the rules as data (spec §6), handed to the TS engine whole.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatSpecRow {
    pub key: String,
    pub display_name: String,
    pub enabled_in_picker: bool,
    pub deck_min: i64,
    pub deck_max: Option<i64>,
    pub max_copies: Option<i64>,
    pub sideboard_max: Option<i64>,
    pub singleton: bool,
    pub requires_commander: bool,
    pub commander_rule: Option<String>,
    pub life: i64,
    pub restricted_semantic: String,
    pub has_legality_data: bool,
    pub max_mana_value: Option<i64>,
    pub allows_companion: bool,
    pub sort_order: i64,
    /// Which platforms the format is playable on — [`crate::schema::GAMES`] words, **split
    /// here** out of the one comma-joined cell `format_specs.games` stores.
    ///
    /// A list rather than the raw string because a string would make every consumer write the
    /// same `split(',')`, and the day one of them wrote `includes()` instead it would answer
    /// that `arena` is playable in `standardbrawl`. Rust supplies the fact as a list; which
    /// formats a picker then offers is TypeScript's conclusion.
    ///
    /// **Never empty**, and the seed is the whole of that guarantee — the column's `NOT NULL`
    /// only stops a NULL, and `''` would split to one empty word. A cell that somehow held one
    /// would take its format out of every filtered picker with nothing on screen saying why,
    /// which is what `a_format_spec_games_cell_holds_only_scryfall_game_words` exists to catch.
    pub games: Vec<String>,
}

/// One deck card and every fact about it, as one row.
///
/// Three joins, and each one's kind is a decision:
///
/// * `LEFT JOIN cards` is [`crate::collection`]'s discipline verbatim — an inner join would
///   delete from the view exactly the rows the denormalised columns exist for.
/// * `LEFT JOIN deck_labels` for the same reason at one remove: `deck_cards.label_id` is
///   `ON DELETE SET NULL`, so an unlabelled row is the ordinary case, not a broken one.
/// * `JOIN deck_categories` is **inner**, and is the only inner join in this file's reads.
///   `category_id` is `NOT NULL` with an enforced foreign key, so a card with no category is
///   a row the schema cannot hold — unlike `card_id`, which is soft by design.
///
/// `ever_uncommon`'s `EXISTS` rides `idx_cards_oracle`, and answers false for an orphan on its
/// own (`NULL = NULL` is not true), which is the right answer — nothing is known about a card
/// that is not there.
///
/// The `ORDER BY` is [`read_deck_cards`]'s contract; see its doc for why it lives in SQL.
fn deck_card_select(marketplace: crate::sorting::Marketplace) -> String {
    // The front face's picture, off the `cards` row this select already joins. Built by
    // `image_uri::front_face_selects` so the precedence between the two columns stays that
    // module's, rather than being respelled as a `COALESCE` here.
    let image_uris = crate::image_uri::front_face_selects("c").join(", ");
    format!(
        "SELECT dc.id, dc.card_id,
            dc.category_id, cat.name, cat.kind, cat.is_active,
            dc.variant, dc.label_id, t.name, t.color,
            dc.quantity, dc.name,
            dc.set_code, dc.collector_number, dc.lang, dc.needs_review,
            c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
            c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
            c.faces, c.game_changer, c.finishes, c.set_name,
            {price} AS unit_price,
            EXISTS(SELECT 1 FROM cards u
                    WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon,
            -- **Last, and that is [`deck_row`]'s rule rather than a preference.** This read is
            -- positional, so a column added anywhere but the end shifts every index after it
            -- into a field of the same SQLite type, silently. `finish` is TEXT and would have
            -- landed in `needs_review` — a sentence field — had it gone beside `lang` where it
            -- reads best.
            dc.finish,
            -- 35, after `dc.finish`, for the reason written directly above it — and this one
            -- is that rule's fourth proof: `promo_types` is TEXT and reads like it belongs
            -- beside `c.finishes` at 30, where it would have handed a printing's finishes to
            -- its treatments and a set name to its finishes, both still plausible strings.
            c.promo_types,
            -- From 36, last of all, for the reason written above `dc.finish`: this read is
            -- positional and a column added anywhere else shifts every index after it into a
            -- field of the same SQLite type, silently. As many columns as
            -- `image_uri::FRONT_FACE_COLUMNS` says — two per variant a list row carries.
            {image_uris}
       FROM deck_cards dc
       JOIN deck_categories cat ON cat.id = dc.category_id
       LEFT JOIN deck_labels t ON t.id = dc.label_id
       LEFT JOIN cards c ON c.id = dc.card_id
      WHERE dc.deck_id = ?1 AND dc.variant = ?2
      ORDER BY cat.sort_order, cat.id, dc.name, dc.id",
        price = crate::sorting::deck_card_price_expr(marketplace)
    )
}

/// The whole deck in one read: the gallery's row, one variant's cards, every category, every
/// label, every fact, every number.
///
/// One command rather than five, because the editor and the validation engine ask the same
/// question — *what is in this deck* — and a screen that draws a curve from one query, a
/// legality panel from another, an owned badge from a third and its column headings from a
/// fourth is a screen whose answers can disagree.
///
/// **`variant` scopes the cards, and every number counted over them.** *Which* categories and
/// *which* labels come back does not depend on it (see [`DeckDetail::categories`]), so switching
/// between the live deck and the theory one changes what is in the columns and never which
/// columns there are — but a category's and a label's `card_count` both count the variant that
/// was asked for, because all three parts of this answer describe one list of cards. Threading
/// it into [`crate::deck_meta::list_categories`] and not into
/// [`crate::deck_meta::list_labels`] is exactly how they came to disagree once.
///
/// **`marketplace` scopes every price in the answer, the categories' totals included**, for the
/// same reason `variant` scopes every count: a column header priced on Cardmarket over rows
/// priced on TCGplayer is a screen whose two halves disagree.
pub fn get_deck(
    conn: &Connection,
    id: i64,
    variant: &str,
    marketplace: crate::sorting::Marketplace,
) -> Result<Option<DeckDetail>, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let Some(deck) = read_deck(conn, id)? else {
        return Ok(None);
    };
    let mut cards = read_deck_cards(conn, id, variant, marketplace)?;
    fill_unknown_power_toughness(conn, &mut cards)?;
    attribute_owned(&mut cards, &owned_by_oracle(conn, id)?);
    let categories = crate::deck_meta::list_categories(conn, id, variant, marketplace)?;
    let labels = crate::deck_meta::list_labels(conn, id, variant)?;
    Ok(Some(DeckDetail {
        deck,
        cards,
        categories,
        labels,
    }))
}

/// Every card in one variant of the deck, in the order the editor reads them.
///
/// **Category `sort_order`, then the name the row carries, then row id** — and it is an
/// `ORDER BY` rather than a `sort_by` because the sort key that decides it (`sort_order`)
/// belongs to the category and is not a field of [`DeckCardRow`]. `cat.id` breaks a tie
/// between two categories the user gave the same order, so the walk is total.
///
/// The name is the *row's*, which an orphan has and its `cards` row does not. This order is
/// the read's own and not the caller's: [`attribute_owned`] hands `owned_quantity` out along
/// it, so the number a row shows must not depend on how a view chose to display the list.
fn read_deck_cards(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<DeckCardRow>, String> {
    // Where the image pair begins — the count of every column before it, which is what makes
    // it last. Written down rather than spelled inside the closure, for the reason
    // `deck_card_select`'s own comment gives.
    const IMAGE_COL: usize = 36;

    let sql = deck_card_select(marketplace);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], |r| {
            Ok(DeckCardRow {
                id: r.get(0)?,
                card_id: r.get(1)?,
                category_id: r.get(2)?,
                category_name: r.get(3)?,
                category_kind: r.get(4)?,
                category_active: r.get(5)?,
                variant: r.get(6)?,
                label_id: r.get(7)?,
                label_name: r.get(8)?,
                label_color: r.get(9)?,
                quantity: r.get(10)?,
                name: r.get(11)?,
                set_code: r.get(12)?,
                collector_number: r.get(13)?,
                lang: r.get(14)?,
                needs_review: r.get(15)?,
                oracle_id: r.get(16)?,
                mana_cost: r.get(17)?,
                cmc: r.get(18)?,
                type_line: r.get(19)?,
                oracle_text: r.get(20)?,
                colors: r.get(21)?,
                color_identity: r.get(22)?,
                legalities: r.get(23)?,
                power: r.get(24)?,
                toughness: r.get(25)?,
                layout: r.get(26)?,
                rarity: r.get(27)?,
                faces: r.get(28)?,
                game_changer: r.get(29)?,
                finishes: r.get(30)?,
                set_name: r.get(31)?,
                unit_price: r.get(32)?,
                ever_uncommon: r.get(33)?,
                // 34, at the end of the list, for the reason written at the column.
                finish: r.get(34)?,
                // 35, after it, for the same reason.
                promo_types: r.get(35)?,
                // From 36 — the (top-level, face) pairs `front_face_selects` added, one per
                // variant, folded back up by the module that added them, face-first precedence
                // and `soon.jpg` fence included.
                image_uris: crate::image_uri::front_face_map(|i| {
                    r.get::<_, Option<String>>(IMAGE_COL + i)
                })?,
                // Filled by `attribute_owned`, once the claims are known.
                owned_quantity: 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Recover a P/T that the `cards` columns do not have yet.
///
/// **Both columns NULL means unknown, never "no P/T box"** — and CR 903.3 (2026) turns on
/// exactly that difference: a legendary Vehicle or Spacecraft *with* a P/T box can be a
/// commander, one without cannot. `power`/`toughness` are schema v5 columns that the ingest
/// fills from here on, but the v5 backfill could only recover the **1 510 of 116 590** rows
/// that keep a `card_faces` array: `raw` is a gzip BLOB, and SQL cannot see into one. Until
/// the next real sync — which the 24 h throttle and the ETag check can put a day or more
/// away — every ordinary creature in every deck reads NULL, and a validator told "no P/T
/// box" would refuse commanders that are legal.
///
/// So the read repairs itself, for the rows that ask and only those: one lookup per distinct
/// printing that is **both** missing its P/T and of a type that could have one, gunzipped
/// **in Rust** through [`crate::card_row::raw_json`] over `CAST(raw AS BLOB)`, because
/// `json_extract` over a gzip member is a hard `malformed JSON` error rather than a NULL
/// (CLAUDE.md).
///
/// The type gate is what keeps this from being permanent: on a *fully synced* database both
/// columns are NULL for every land, instant, sorcery, enchantment and ordinary artifact —
/// Scryfall simply omits the keys, and NULL is then the correct answer — so an ungated
/// recovery would inflate and parse a 2 KB blob for the majority of every deck, forever,
/// and find nothing every time. See [`may_have_a_power_toughness_box`].
fn fill_unknown_power_toughness(conn: &Connection, rows: &mut [DeckCardRow]) -> Result<(), String> {
    let unknown: Vec<String> = {
        let mut ids: Vec<String> = rows
            .iter()
            .filter(|r| {
                r.power.is_none()
                    && r.toughness.is_none()
                    && may_have_a_power_toughness_box(r.type_line.as_deref())
            })
            .map(|r| r.card_id.clone())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    if unknown.is_empty() {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT CAST(raw AS BLOB) FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut printed: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for card_id in unknown {
        let stored: Option<Vec<u8>> = stmt
            .query_row(params![card_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        // An orphan has no `raw` to read, and that is the honest answer for it too.
        let Some(json) = stored.as_deref().and_then(crate::card_row::raw_json) else {
            continue;
        };
        printed.insert(card_id, printed_power_toughness(&json));
    }
    for row in rows.iter_mut() {
        if let Some((power, toughness)) = printed.get(&row.card_id) {
            row.power.clone_from(power);
            row.toughness.clone_from(toughness);
        }
    }
    Ok(())
}

/// Whether a missing P/T is worth going to `raw` for.
///
/// The three types that print a P/T box: creatures, and — since 2026 — Vehicles and
/// Spacecraft, which is the same list CR 903.3 gives for what a legendary permanent must be
/// to command a deck. Everything else has no box, so NULL is not a gap in the data but the
/// fact itself, and looking is a guaranteed miss.
///
/// Matched against the **whole** type line, which is why a transform card is covered: `cards`
/// stores the combined `"Land // Legendary Creature — Demon"`, so a back-face creature is
/// found by the same substring. A **NULL** type line is treated as *could be* — an orphan has
/// no type line and neither does a card row that arrived without one, and the conservative
/// direction for an unknown is to look. One wasted lookup is cheaper than a commander refused.
fn may_have_a_power_toughness_box(type_line: Option<&str>) -> bool {
    match type_line {
        None => true,
        Some(t) => ["Creature", "Vehicle", "Spacecraft"]
            .iter()
            .any(|k| t.contains(k)),
    }
}

/// A bulk line's printed P/T: top level, then the front face — [`crate::card_row`]'s own
/// fallback, because a transform card keeps its P/T only on its faces.
fn printed_power_toughness(json: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return (None, None);
    };
    let pick = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                value
                    .get("card_faces")
                    .and_then(|f| f.get(0))
                    .and_then(|f| f.get(key))
                    .and_then(serde_json::Value::as_str)
            })
            .map(str::to_owned)
    };
    (pick("power"), pick("toughness"))
}

/// Copies this deck **holds**, per oracle card.
///
/// Since schema v25 this is a question about where a collection row physically sits: a deck's
/// group is one `collection_folders` row with `kind = 'deck'` and `deck_id` set, and every
/// `collection_entries` row filed into it is a copy in that deck. There is nothing to clamp any
/// more and nothing that can be out of date — the old `min(a.quantity, e.quantity)` existed
/// because a *claim* could out-live the row it was made against, and custody cannot.
///
/// **Grouped by oracle id, and that is deliberately not the printing.** A Bolt is a Bolt: the
/// deck may list the Alpha printing while the copy in the box is the M10 one, and the old
/// allocator matched across printings for exactly that reason. Keeping it is what makes a reader
/// who let the allocator choose see the same answer after the upgrade as before it.
///
/// **`JOIN cards` is an INNER join**, for the reason it always was: an orphaned row names no
/// oracle card, so it reads owned 0 until the reconciler or the next sync gives it its identity
/// back. It is still listed and still flagged — [`crate::collection`]'s `FROM` discipline is
/// about the rows a *list* shows, and this is a lookup rather than a list.
fn owned_by_oracle(conn: &Connection, deck_id: i64) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.oracle_id, sum(e.quantity)
               FROM collection_entries e
               JOIN collection_folders f ON f.id = e.folder_id
               JOIN cards c ON c.id = e.card_id
              WHERE f.deck_id = ?1 AND c.oracle_id IS NOT NULL
              GROUP BY c.oracle_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|e| e.to_string())
}

/// Hand the held copies out to the rows that wanted them.
///
/// Pure, and deliberately so: this is the one piece of the availability story with no SQL in
/// it. The walk is the slice's own order, which is [`read_deck_cards`]' `ORDER BY` — the
/// read's order and not a caller's, which is the property that matters: a list that sorted
/// itself differently before calling this would attribute differently, and the number a row
/// shows must not depend on how it was displayed. `get_deck` is the only caller and hands the
/// rows straight over.
///
/// **Two kinds of row are passed over rather than served last**, and the shape is unchanged
/// from the allocator's day even though the reason for each has moved. A row in an **inactive**
/// category: a switched-off pile counts toward nothing anywhere in the app, so letting it take
/// from the pool would move copies off the rows that *are* the deck onto a scratchpad. And a
/// row in the **theory** list, which is the subtler one: a plan reserves nothing, so a theory
/// read must not hand it the copies the sleeved deck is holding.
///
/// **The `variant != LIVE` test is now true by construction rather than because the table
/// lacked a variant column**, and that is worth saying plainly because it reads like a leftover.
/// It used to be a fence around `deck_allocations` carrying no variant — a theory read walked
/// the *live* deck's claims and would otherwise have handed a plan somebody else's copies. A
/// group is not scoped to a variant either, so the map [`owned_by_oracle`] answers is still the
/// whole deck's; what has changed is that the map is now a fact about where cards *are* rather
/// than a ledger of what was reserved. The conclusion is the same one and is still drawn here,
/// explicitly, rather than left to a table's shape — pinned by
/// `the_allocator_claims_nothing_for_the_theory_variant`.
fn attribute_owned(rows: &mut [DeckCardRow], owned_by_oracle: &HashMap<String, i64>) {
    let mut left = owned_by_oracle.clone();
    for row in rows.iter_mut() {
        // **A plan reserves nothing.** A group holds what the deck physically has, whichever
        // list the reader is looking at, so a theory read would otherwise hand a plan the very
        // copies the sleeved deck is holding — which is why this test comes out of `claimed_for`
        // and stands on its own rather than being folded in with the category one below.
        if row.variant != LIVE {
            row.owned_quantity = 0;
            continue;
        }
        let counted_for = row.category_active;
        let Some(oracle) = row.oracle_id.clone().filter(|_| counted_for) else {
            row.owned_quantity = 0;
            continue;
        };
        let remaining = left.entry(oracle).or_insert(0);
        let take = (*remaining).min(row.quantity).max(0);
        *remaining -= take;
        row.owned_quantity = take;
    }
}

/// One wish per card the deck is still short of. Returns how many wishes were touched.
///
/// **Any printing**, always: a shopping list is not a printing preference, and the copy that
/// fills the hole is whichever one turns up. An **inactive** category is not counted, and the
/// **theory** list is not read at all — a card the user has not decided to play is not a card
/// they need to buy, whether the undecidedness is a switched-off category or a whole plan.
///
/// Written *through* [`crate::wishlist::add_wish`] rather than into `wishlist_entries`: the
/// grain, the canonicalisation and the fold all live there, and a second write path is a
/// second set of rules to keep in step. Clicking twice therefore raises the quantity of one
/// line rather than making two, which is `add_wish`'s contract and not this function's.
///
/// **Nothing is reallocated first, and there is nothing left that could be out of date.** This
/// used to open by rebuilding the deck's claims, because a claim ledger could be a collection
/// edit behind and a button that puts already-bought cards on a shopping list is worse than no
/// button. Since schema v25 what the deck holds is where its rows physically sit, which the read
/// below asks about directly.
///
/// An orphaned row is skipped: a wish needs an oracle card or a printing that resolves, and
/// an orphan has neither. It is already carrying a `needs_review` sentence that says so.
///
/// **Records no history**, and it is the one card-adjacent command that does not: nothing about
/// the deck changed. It writes the wishlist and it reads this deck — and neither is a change to
/// what the deck plays, so the drawer would be reporting a shopping trip as an edit. (This read
/// *"it rewrites this deck's claims"* four lines under the paragraph saying nothing is
/// reallocated; there are no claims to rewrite since schema v25, and this command writes no
/// deck table at all.)
pub fn missing_to_wishlist(conn: &Connection, deck_id: i64) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The default marketplace, and it costs nothing to be wrong about: this reads names,
    // quantities and claims, and never a price. Threading the setting in would only make a
    // shopping list depend on where the user shops.
    let detail = get_deck(&tx, deck_id, LIVE, crate::sorting::Marketplace::default())?
        .ok_or_else(|| GONE.to_owned())?;

    // Oracle-grained, so the same card short in two categories is one wish for the sum —
    // which is what "one wish per card still missing" means, and what the reader would count.
    let mut missing: BTreeMap<String, (String, i64)> = BTreeMap::new();
    for row in &detail.cards {
        if !row.category_active {
            continue;
        }
        let Some(oracle_id) = row.oracle_id.as_deref() else {
            continue;
        };
        let short = row.quantity - row.owned_quantity;
        if short <= 0 {
            continue;
        }
        let entry = missing
            .entry(oracle_id.to_owned())
            .or_insert_with(|| (row.name.clone(), 0));
        entry.1 += short;
    }

    let touched = missing.len();
    for (oracle_id, (name, quantity)) in missing {
        crate::wishlist::add_wish(
            &tx,
            &crate::wishlist::WishInput {
                oracle_id: Some(oracle_id),
                // The deck row's own name, which is the one name an orphan-safe row always
                // has — and the same name the list would show for it.
                name: Some(name),
                quantity,
                ..Default::default()
            },
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(touched)
}

/// The format rules, as data (spec §6), in the order a picker shows them.
///
/// Read whole and handed to the engine: a new format is a seeded row, never a code branch,
/// and that is only true if nothing here decides which cells matter.
pub fn list_format_specs(conn: &Connection) -> Result<Vec<FormatSpecRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT key, display_name, enabled_in_picker, deck_min, deck_max, max_copies,
                    sideboard_max, singleton, requires_commander, commander_rule, life,
                    restricted_semantic, has_legality_data, max_mana_value, allows_companion,
                    sort_order, games
               FROM format_specs ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FormatSpecRow {
                key: r.get(0)?,
                display_name: r.get(1)?,
                enabled_in_picker: r.get(2)?,
                deck_min: r.get(3)?,
                deck_max: r.get(4)?,
                max_copies: r.get(5)?,
                sideboard_max: r.get(6)?,
                singleton: r.get(7)?,
                requires_commander: r.get(8)?,
                commander_rule: r.get(9)?,
                life: r.get(10)?,
                restricted_semantic: r.get(11)?,
                has_legality_data: r.get(12)?,
                max_mana_value: r.get(13)?,
                allows_companion: r.get(14)?,
                sort_order: r.get(15)?,
                // Split here rather than by the caller, so the cell's storage shape stops at
                // this line — see [`FormatSpecRow::games`]. `filter` over the empty string
                // because `"".split(',')` yields one empty word, and a `games` of `[""]` is a
                // format no filtered picker would ever offer.
                games: r
                    .get::<_, String>(16)?
                    .split(',')
                    .filter(|g| !g.is_empty())
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// What a deck write says when its worker thread died under it. Never a user's problem —
/// the write itself answers [`crate::db::BUSY`] when the database is busy.
#[cfg(not(target_family = "wasm"))]
fn unfinished(e: tauri::Error) -> String {
    format!("the deck could not be written: {e}")
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck: DeckInput,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| create_deck(c, &deck)))
        .await
        .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    patch: DeckPatch,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| update_deck(c, id, &patch))
    })
    .await
    .map_err(unfinished)?
}

/// Delete a deck.
///
/// **No `AppHandle`, where every other wrapper in this pair has one**: this took one solely to
/// resolve the covers directory so the deck's `<id>.webp` could go with it, and custom covers
/// went on 2026-08-31.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_delete(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though this files the deck's whole group into
        // `Recently removed`** — [`deck_clear`]'s note, and [`release_live_copies`] carries the
        // argument: every row keeps its `card_id` and only its folder changes, and the facet
        // index's `owned` dimension names no folder.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| delete_deck(c, id))
    })
    .await
    .map_err(unfinished)?
}

/// Copy a deck, its categories, its labels and its cards. See [`duplicate_deck`].
///
/// **No `AppHandle`, for [`deck_delete`]'s reason**: it carried one only to resolve the covers
/// directory the copy's own `<id>.webp` was written into.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_duplicate(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| duplicate_deck(c, id))
    })
    .await
    .map_err(unfinished)?
}

/// File a deck under a folder, or with `folderId: null` back at the root of the tree — the one
/// thing [`DeckPatch`] cannot express. See [`set_folder`].
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_set_folder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_folder(c, deck_id, folder_id))
    })
    .await
    .map_err(unfinished)?
}

/// Remember where the reader was looking at this deck. See [`set_view_state`] — it moves no
/// `updated_at`, records no history and reallocates nothing.
///
/// Answers `()` rather than a [`DeckRow`]: every other write here hands back the row the gallery
/// would read, because every other write changes something a gallery draws. This changes one
/// thing the *editor* will read on its next open, and a caller that re-rendered a deck tile over
/// it would be redrawing for a scroll position.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_set_view_state(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    view_state: DeckViewState,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_view_state(c, deck_id, &view_state))
    })
    .await
    .map_err(unfinished)?
}

/// The deck gallery. **Read-only** connection, blocking pool — as every read in this app
/// is, so a gallery never queues behind a sync.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<DeckRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_decks(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck list could not be read: {e}"))?
}

/// One deck, one variant's cards, every category and label, every fact the validator needs.
/// **Read-only** connection.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_get(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    variant: String,
    marketplace: Option<String>,
) -> Result<Option<DeckDetail>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        get_deck(
            &crate::sync::lock_db_read(&state),
            id,
            &variant,
            marketplace,
        )
    })
    .await
    .map_err(|e| format!("the deck could not be read: {e}"))?
}

/// The format rules as data, for the picker and the validation engine. **Read-only.**
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn format_specs_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<FormatSpecRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_format_specs(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the format list could not be read: {e}"))?
}

/// The format the last created deck was in, for the New deck dialog to open on. **Read-only.**
///
/// `null` means no deck has ever been created here — a fresh install, or a database whose
/// `app_meta` row predates this key. The caller decides what to show for that, and for a key
/// the picker no longer offers; see [`last_deck_format`]. The `Result` is `spawn_blocking`'s
/// join and nothing else, because the read itself has no failure mode: `get_app_meta` reads an
/// unreadable row as `None`.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_last_format(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        last_deck_format(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the last deck format could not be read: {e}"))
}

/// Whether the deck editor's card search column was last left open. **Read-only.**
///
/// Read-only connection on the blocking pool, exactly as [`crate::card::printing_group_by`]
/// runs and for the same reason: this is read as a deck is being opened, and a preference that
/// queued behind an ~80 s ingest on the write connection would hold the whole editor behind it.
/// The `Result` is `spawn_blocking`'s join and nothing else — every way the read itself could go
/// wrong is already a reason to answer [`DEFAULT_DECK_SEARCH_OPEN`].
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_search_open(state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        stored_deck_search_open(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the search column state could not be read: {e}"))
}

/// Remember whether the search column is open. Answers [`crate::db::BUSY`] if a sync holds the
/// write connection — the bound every write command in this crate takes.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_deck_search_open(
    state: tauri::State<'_, Arc<AppState>>,
    open: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_deck_search_open(conn, open))
    })
    .await
    .map_err(|e| format!("the search column state could not be saved: {e}"))?
}

/// The one click: everything this deck is short of, onto the wishlist.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_missing_to_wishlist(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| missing_to_wishlist(c, deck_id))
    })
    .await
    .map_err(unfinished)?
}

/// Put copies into a category. **`categoryId` or `categoryName`, and at least one** — see
/// [`add_card`] for which wins when both arrive.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_add_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: Option<i64>,
    category_name: Option<String>,
    variant: String,
    finish: Option<String>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            add_card(
                c,
                deck_id,
                &card_id,
                category_id,
                category_name.as_deref(),
                &variant,
                finish.as_deref(),
                quantity,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_set_card_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    finish: Option<String>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            set_card_quantity(
                c,
                deck_id,
                &card_id,
                category_id,
                &variant,
                finish.as_deref(),
                quantity,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// Answers the copies it removed, so the caller can say what happened without re-reading the
/// deck to work it out.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_category_clear(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    category_id: i64,
    variant: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though a `live` clear writes `collection_entries`.** The
        // release moves rows *between folders* and folds some of them away, and
        // `with_write_owned`'s whole extra step is the facet index's folder-blind `owned`
        // dimension — so no card enters or leaves the reader's ownership here. The argument in
        // full is on [`release_live_copies`].
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            clear_category(c, deck_id, category_id, &variant)
        })
    })
    .await
    .map_err(unfinished)?
}

/// Answers the copies it removed, so the caller can say what happened without re-reading the
/// deck to work it out.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_clear(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though a `live` clear writes `collection_entries`** —
        // [`deck_category_clear`]'s note at this scope, and [`release_live_copies`] carries the
        // argument: the release re-files rows between folders, and the facet index's `owned`
        // dimension names no folder.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| clear_variant(c, deck_id, &variant))
    })
    .await
    .map_err(unfinished)?
}

/// A drag onto a column, and the quick zones' `Auto` — one command, two ways of naming the
/// target, which is [`add_card`]'s arrangement and is documented on [`move_card`]. Answers the
/// category the copies are now in, because the name arm's caller has no other way to learn what
/// was found or made.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_move_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    from_category_id: i64,
    to_category_id: Option<i64>,
    to_category_name: Option<String>,
    variant: String,
    finish: Option<String>,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            move_card(
                c,
                deck_id,
                &card_id,
                from_category_id,
                to_category_id,
                to_category_name.as_deref(),
                &variant,
                finish.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// The card pane's "Use this printing". `deckId` like every other card write's, because
/// `decks.id` is an integer everywhere it is written.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_swap_printing(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    from_card_id: String,
    to_card_id: String,
    category_id: i64,
    variant: String,
    finish: Option<String>,
) -> Result<SwapResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            swap_printing(
                c,
                deck_id,
                &from_card_id,
                &to_card_id,
                category_id,
                &variant,
                finish.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// The deck card menu's `Set as foil` and the card pane's own button. `fromFinish` is the row
/// being addressed and `toFinish` what it should become — both `null` for the regular copy,
/// which is the only spelling of it that reaches the column.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_set_card_finish(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    from_finish: Option<String>,
    to_finish: Option<String>,
) -> Result<SwapResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            set_card_finish(
                c,
                deck_id,
                &card_id,
                category_id,
                &variant,
                from_finish.as_deref(),
                to_finish.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marketplace a test that is **not about prices** reads through. Named rather than
    /// spelled `Marketplace::default()` at fifteen call sites, so that the handful of tests
    /// that do care about the shop stand out by naming one.
    const ANY_MARKET: crate::sorting::Marketplace = crate::sorting::Marketplace::Tcgplayer;

    /// Five printings of two oracle cards.
    ///
    /// **The `finishes` lists are the real ones**, which is what makes them useful rather than
    /// decorative: Alpha printed no foils, so `bolt-lea` is the card `set_card_finish` must
    /// refuse foil on, and M10 did, so `bolt-m10` is the one it must accept. A fixture that
    /// said `["nonfoil","foil"]` everywhere would make the refusal untestable and the
    /// acceptance meaningless.
    ///
    /// `o1` is three printings of one common — the allocator's cross-printing walk needs a
    /// second and a third printing of the *same* card to have anything to walk. `o2` is the
    /// pair the read is judged on: Serra Angel was **uncommon** in Alpha and **rare** in
    /// Eighth, and Old School accepts the Alpha printing and refuses the Eighth. One
    /// fixture, both traps, and neither of them invented — those are the real rarities and
    /// the real legalities.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,artist,mana_cost,cmc,type_line,oracle_text,colors,color_identity,
                    legalities,power,toughness,prices,finishes,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  'Christopher Rush','{R}',1.0,'Instant',
                  'Lightning Bolt deals 3 damage to any target.','R','R',
                  '{"oldschool":"legal","modern":"legal"}',NULL,NULL,
                  '{"usd":"400.00","usd_foil":null}','["nonfoil"]','{}'),
                 ('bolt-jp','o1','Lightning Bolt','4ed','209','ja','normal','common',
                  'Christopher Rush','{R}',1.0,'Instant',
                  'Lightning Bolt deals 3 damage to any target.','R','R',
                  '{"oldschool":"not_legal","modern":"legal"}',NULL,NULL,NULL,
                  '["nonfoil"]','{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  'Christopher Moeller','{R}',1.0,'Instant',
                  'Lightning Bolt deals 3 damage to any target.','R','R',
                  '{"oldschool":"not_legal","modern":"legal"}',NULL,NULL,
                  '{"usd":"1.50","usd_foil":"6.00"}','["nonfoil","foil"]','{}'),
                 ('serra-lea','o2','Serra Angel','lea','175','en','normal','uncommon',
                  'Douglas Shuler','{3}{W}{W}',5.0,'Creature — Angel','Flying, vigilance',
                  'W','W','{"oldschool":"legal","paupercommander":"not_legal"}','4','4',
                  '{"usd":"120.00"}','["nonfoil"]','{}'),
                 ('serra-8ed','o2','Serra Angel','8ed','44','en','normal','rare',
                  'Greg Staples','{3}{W}{W}',5.0,'Creature — Angel','Flying, vigilance',
                  'W','W','{"oldschool":"not_legal","paupercommander":"not_legal"}','4','4',
                  '{"usd":"1.00"}','["nonfoil"]','{}');"#,
        )
        .unwrap();
        conn
    }

    /// The deck's predefined category of one `kind` — the row [`create_deck`] seeded through
    /// `deck_meta::ensure_predefined_categories`. Panics rather than creating one: a deck
    /// missing a predefined kind is a broken invariant, not a fixture to paper over.
    fn kind_of(conn: &Connection, deck_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = ?2",
            params![deck_id, kind],
            |r| r.get(0),
        )
        .unwrap_or_else(|e| panic!("deck {deck_id} has no `{kind}` category: {e}"))
    }

    /// The deck's main pile, made on first ask.
    ///
    /// There is no predefined `main` category — a deck may own any number of them, so the
    /// schema predefines none — and this is `deck_meta::category_for_name`, which is exactly
    /// the call [`add_card`]'s name arm makes. So a test that asks for it twice gets one
    /// category, the same way the app does.
    fn main_of(conn: &Connection, deck_id: i64) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, "Main deck").unwrap()
    }

    /// [`add_card`] by explicit category, in the live variant, **as the regular copy** — the
    /// shape almost every test below wants, so the arms it does not want stay visible where
    /// they are used. [`add_foil`] is the same thing one finish over.
    fn add(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        category_id: i64,
        quantity: i64,
    ) -> EntryChange {
        add_card(
            conn,
            deck_id,
            card_id,
            Some(category_id),
            None,
            LIVE,
            None,
            quantity,
        )
        .unwrap()
    }

    /// [`add`], in foil. Named rather than spelled out at each site so that a test about the
    /// finish reads as one at a glance, and so the `None` above stays the visible default.
    fn add_foil(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        category_id: i64,
        quantity: i64,
    ) -> EntryChange {
        add_card(
            conn,
            deck_id,
            card_id,
            Some(category_id),
            None,
            LIVE,
            Some("foil"),
            quantity,
        )
        .unwrap()
    }

    /// One collection row, at the plainest grain there is.
    fn own(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The collection group that stands for this deck — the `collection_folders` row
    /// [`create_deck`] makes. Panics rather than creating one, [`kind_of`]'s rule: a deck with
    /// no group is a broken invariant and not a fixture to paper over.
    fn group_of(conn: &Connection, deck_id: i64) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|e| panic!("deck {deck_id} has no collection group: {e}"))
    }

    /// One collection row filed into the deck's own group — what "this deck holds this card"
    /// means since schema v25. Written through [`crate::collection::add_entry`] and then
    /// [`crate::collection_folders::refile_entry`], which is the app's own pair of writes
    /// rather than a hand-built row: the grain and the merge are theirs.
    fn file_into_group(conn: &Connection, deck_id: i64, card_id: &str, quantity: i64) -> i64 {
        let folder = group_of(conn, deck_id);
        let entry = own(conn, card_id, quantity);
        crate::collection_folders::refile_entry(conn, entry, Some(folder))
            .unwrap()
            .id
    }

    /// Copies of one printing sitting in one folder — `0` when it holds none. A sum over
    /// `quantity` rather than a row count, because a split leaves two rows where there was one
    /// and the question every test here asks is how many *cards* are in a place.
    fn folder_copies(conn: &Connection, folder: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE folder_id = ?1 AND card_id = ?2",
            params![folder, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The one holding area `Recently removed`, by id.
    fn removed_group(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .expect("every database past v25 has one `removed` folder")
    }

    fn card_row<'a>(detail: &'a DeckDetail, card_id: &str, category_id: i64) -> &'a DeckCardRow {
        detail
            .cards
            .iter()
            .find(|r| r.card_id == card_id && r.category_id == category_id)
            .unwrap_or_else(|| panic!("no `{card_id}` in category {category_id}"))
    }

    /// What the deck says it owns of one printing, read the way the editor reads it.
    fn owned_of(conn: &Connection, deck_id: i64, card_id: &str, category_id: i64) -> i64 {
        let detail = get_deck(conn, deck_id, LIVE, ANY_MARKET).unwrap().unwrap();
        card_row(&detail, card_id, category_id).owned_quantity
    }

    /// The plainest deck there is: a name, a format, and every other column at its default.
    /// The wide creates live in the handful of tests that are *about* the widened input, so
    /// that the sixty tests which only need a deck to exist keep saying so.
    fn input(name: &str, format_key: &str) -> DeckInput {
        DeckInput {
            name: name.to_owned(),
            format_key: format_key.to_owned(),
            ..Default::default()
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// The card write is the collection quick-add's contract on the deck grain: the same
    /// printing in the same category twice is one row with a bigger number, and the printing
    /// AND name are denormalized from `cards` at write time — the only moment they are
    /// knowable, and the reason the row outlives the id (spec §6, CLAUDE.md).
    #[test]
    fn adding_the_same_card_to_the_same_category_twice_folds() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);

        let first = add(&conn, deck.id, "bolt-jp", main, 2);
        let second = add(&conn, deck.id, "bolt-jp", main, 2);

        assert_eq!(first.id, second.id, "the same grain is the same row");
        assert_eq!(second.quantity, 4);
        assert_eq!(count(&conn, "deck_cards"), 1);

        let (set, cn, lang, name): (String, String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang, name FROM deck_cards WHERE id = ?1",
                params![second.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (set.as_str(), cn.as_str(), lang.as_str(), name.as_str()),
            ("4ed", "209", "ja", "Lightning Bolt"),
            "the printing and the name are copied from `cards` at write time"
        );

        // `category_id` is in the grain: the same printing in the Maybeboard is a second
        // intention, not the same row somewhere else.
        let scratch = add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "maybe"),
            1,
        );
        assert_ne!(scratch.id, second.id);
        assert_eq!(count(&conn, "deck_cards"), 2);

        // …and so is `variant`: a change tried out in Theory is a row of its own, never a
        // draft that could silently overwrite the deck as it is sleeved.
        let theory =
            add_card(&conn, deck.id, "bolt-jp", Some(main), None, THEORY, None, 3).unwrap();
        assert_ne!(theory.id, second.id);
        assert_eq!(
            theory.quantity, 3,
            "and it started from nothing, not from 4"
        );
        assert_eq!(count(&conn, "deck_cards"), 3);
    }

    /// The add path's other arm: a **name** rather than an id, found-or-created. This is what
    /// "when a card is added but not to a specific category, it should find its card category
    /// or create it" means — the word is computed in TypeScript, the find-or-create is here.
    #[test]
    fn adding_by_category_name_finds_or_creates_one_and_needing_neither_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let before = count(&conn, "deck_categories");

        let first = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            None,
            Some("Burn spells"),
            LIVE,
            None,
            2,
        )
        .unwrap();
        let second = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            None,
            Some("Burn spells"),
            LIVE,
            None,
            2,
        )
        .unwrap();

        assert_eq!(first.id, second.id, "the second add found the first's pile");
        assert_eq!(second.quantity, 4);
        assert_eq!(
            count(&conn, "deck_categories"),
            before + 1,
            "one new category, not two"
        );
        let (name, kind, active): (String, String, bool) = conn
            .query_row(
                "SELECT cat.name, cat.kind, cat.is_active
                   FROM deck_cards dc JOIN deck_categories cat ON cat.id = dc.category_id
                  WHERE dc.id = ?1",
                params![first.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (name.as_str(), kind.as_str(), active),
            ("Burn spells", "main", true),
            "a category the user's own cards made is a `main` one, and it counts"
        );

        // Neither an id nor a name is refused in words, and before anything is written:
        // `deck_cards.category_id` is NOT NULL, so there is no row to make.
        let err = add_card(&conn, deck.id, "bolt-m10", None, None, LIVE, None, 1).unwrap_err();
        assert_eq!(err, NO_CATEGORY);
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");

        // Both: the id wins, because it is the more specific instruction and the one a drag
        // carries. The name is not even looked at, so no category is made for it.
        let categories = count(&conn, "deck_categories");
        let explicit = add_card(
            &conn,
            deck.id,
            "bolt-m10",
            Some(kind_of(&conn, deck.id, "side")),
            Some("Ignored"),
            LIVE,
            None,
            1,
        )
        .unwrap();
        assert_eq!(count(&conn, "deck_categories"), categories);
        let landed: String = conn
            .query_row(
                "SELECT cat.name FROM deck_cards dc
                   JOIN deck_categories cat ON cat.id = dc.category_id WHERE dc.id = ?1",
                params![explicit.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(landed, "Sideboard");
    }

    /// The two fences every card write opens with: a variant the schema does not know, and a
    /// category id that resolves to another deck's pile. Neither is stopped by the DDL —
    /// `deck_cards.category_id`'s foreign key only asks that the category *exist* — so both
    /// are refused here, in words, before a row can be filed into the wrong deck.
    #[test]
    fn an_unknown_variant_and_another_decks_category_are_both_refused_in_words() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let other = create_deck(&conn, &input("Angels", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let theirs = main_of(&conn, other.id);

        let err = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(main),
            None,
            "draft",
            None,
            1,
        )
        .unwrap_err();
        assert!(err.contains("draft"), "{err}");
        for variant in crate::schema::DECK_VARIANTS {
            assert!(
                err.contains(variant),
                "the refusal names `{variant}`: {err}"
            );
        }

        let err = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(theirs),
            None,
            LIVE,
            None,
            1,
        )
        .unwrap_err();
        assert_eq!(err, crate::deck_meta::CATEGORY_WRONG_DECK);

        let err = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(theirs + 999),
            None,
            LIVE,
            None,
            1,
        )
        .unwrap_err();
        assert_eq!(
            err,
            crate::deck_meta::CATEGORY_GONE,
            "gone and not-yours are different things to tell a stale editor"
        );
        assert_eq!(count(&conn, "deck_cards"), 0, "and nothing was written");

        // Every card write runs the same two fences, so the CHECK and the FK never reach a
        // user. **The row has to exist first and the refusal has to be compared by text**, and
        // both halves are the point: with an empty deck every one of these calls errors at its
        // row lookup instead, with `card_gone`, so an `is_err()` here goes on passing with the
        // fences deleted from all three commands. That is what this assertion used to be.
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert_eq!(
            set_card_quantity(&conn, deck.id, "bolt-lea", theirs, LIVE, None, 1).unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK
        );
        let err =
            set_card_quantity(&conn, deck.id, "bolt-lea", main, "draft", None, 1).unwrap_err();
        assert!(err.contains("draft"), "{err}");
        assert_eq!(
            move_card(
                &conn,
                deck.id,
                "bolt-lea",
                main,
                Some(theirs),
                None,
                LIVE,
                None
            )
            .unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK,
            "the destination is fenced as well as the source"
        );
        assert_eq!(
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", theirs, LIVE, None).unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK
        );
        assert_eq!(
            count(&conn, "deck_cards"),
            1,
            "and the one row that does exist is untouched"
        );
    }

    #[test]
    fn zero_removes_the_deck_card_and_negative_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let added = add(&conn, deck.id, "bolt-lea", main, 4);

        let lowered = set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, None, 1).unwrap();
        assert_eq!(
            (lowered.id, lowered.quantity, lowered.removed),
            (added.id, 1, false),
            "an absolute quantity, not an addition"
        );

        let err = set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, None, -1).unwrap_err();
        assert!(err.contains("is not a quantity"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and it never deletes");

        let removed = set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, None, 0).unwrap();
        assert_eq!(
            (removed.id, removed.quantity, removed.removed),
            (added.id, 0, true)
        );
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    /// `Clear stack` empties **one pile of one variant**, and the two things it must not
    /// reach are the other pile and the other list.
    ///
    /// The theory half is the one worth the seeding: a clear is the opposite of
    /// [`crate::deck_meta::delete_category`], which takes both lists because the CASCADE does.
    /// Nothing in the `WHERE` would go red if `variant` were dropped from it — the live rows
    /// still vanish — so the theory row is what pins the scope.
    #[test]
    fn clearing_a_stack_empties_one_pile_of_one_variant() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");

        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-m10", main, 3);
        add(&conn, deck.id, "bolt-lea", side, 2);
        add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(main),
            None,
            THEORY,
            None,
            1,
        )
        .unwrap();

        // Copies, not rows: two printings at 4 and 3 is the 7 the confirmation quoted.
        let cleared = clear_category(&conn, deck.id, main, LIVE).unwrap();
        assert_eq!(cleared, 7, "copies, never the two rows it deleted");

        let rows: Vec<(i64, String, i64)> = conn
            .prepare(
                "SELECT category_id, variant, quantity FROM deck_cards
                  WHERE deck_id = ?1 ORDER BY category_id, variant",
            )
            .unwrap()
            .query_map(params![deck.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // Sideboard first: it is a seeded predefined pile, and `main_of` creates "Main deck" on
        // first ask, so the id it gets is the higher one.
        assert_eq!(
            rows,
            vec![(side, LIVE.to_owned(), 2), (main, THEORY.to_owned(), 1)],
            "the theory copy in the same pile stays, and so does the other pile's live row"
        );

        let history = crate::deck_audit::list(&conn, deck.id, 10).unwrap();
        let removes: Vec<(i64, Option<String>, serde_json::Value)> = history
            .iter()
            .filter(|r| r.kind == crate::deck_audit::REMOVE)
            .map(|r| {
                (
                    r.delta,
                    r.card_id.clone(),
                    serde_json::from_str(&r.payload).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            removes,
            vec![(
                -7,
                None,
                json!({ "action": "clear", "category": "Main deck", "cards": 7 })
            )],
            "one row for the whole pile, naming no card because the event is about a pile — \
             and carrying the `action` that keeps `auditText.ts` from reading it as \
             `Removed 7 × a card`"
        );
    }

    /// An empty pile is not a write. No history, no `updated_at`, no allocator run — the same
    /// choice [`set_card_quantity`]'s zero arm makes, for the same stated reason.
    #[test]
    fn clearing_an_empty_stack_writes_nothing_at_all() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 4);

        conn.execute(
            "UPDATE decks SET updated_at = 0 WHERE id = ?1",
            params![deck.id],
        )
        .unwrap();
        let before = crate::deck_audit::list(&conn, deck.id, 50).unwrap().len();

        assert_eq!(clear_category(&conn, deck.id, side, LIVE).unwrap(), 0);
        assert_eq!(
            crate::deck_audit::list(&conn, deck.id, 50).unwrap().len(),
            before,
            "a `remove` of zero copies is a history of a change that never happened"
        );
        let touched: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            touched, 0,
            "and opening a menu on an empty column does not move the deck"
        );
    }

    /// The two fences every card write opens with, on the one command that takes a category
    /// without taking a card.
    #[test]
    fn clearing_a_stack_runs_the_same_two_fences() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let theirs = main_of(
            &conn,
            create_deck(&conn, &input("Somebody else's", "modern"))
                .unwrap()
                .id,
        );
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        assert_eq!(
            clear_category(&conn, deck.id, theirs, LIVE).unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK
        );
        assert_eq!(
            clear_category(&conn, deck.id, main + 9_999, LIVE).unwrap_err(),
            crate::deck_meta::CATEGORY_GONE,
            "gone and not-yours stay different things to tell a stale editor"
        );
        let err = clear_category(&conn, deck.id, main, "draft").unwrap_err();
        assert!(err.contains("draft"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was emptied");
    }

    /// **Clearing a pile gives the copies behind it back.** A `deck_cards` row is an intention
    /// and dies with the press; a row in the deck's group is a card the reader physically owns,
    /// and it goes to `Recently removed` — [`crate::collection_alloc::deck_to_collection`]'s act
    /// in bulk. Without it the copies stay filed under a deck that has never heard of them:
    /// invisible, and unavailable to every other deck for ever.
    ///
    /// **The split is the half worth seeding.** The group holds *one* row for the grain, three
    /// copies backing two piles, so clearing the main deck may take two of them and no more —
    /// a whole-row refile would empty the sideboard as well and nothing on screen would say so.
    #[test]
    fn clearing_a_pile_files_its_copies_into_recently_removed() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 2);
        add(&conn, deck.id, "bolt-lea", side, 1);
        file_into_group(&conn, deck.id, "bolt-lea", 3);

        assert_eq!(clear_category(&conn, deck.id, main, LIVE).unwrap(), 2);

        let group = group_of(&conn, deck.id);
        assert_eq!(
            folder_copies(&conn, removed_group(&conn), "bolt-lea"),
            2,
            "the two the main deck was holding are on the reader's desk"
        );
        assert_eq!(
            folder_copies(&conn, group, "bolt-lea"),
            1,
            "and the sideboard's copy is still the deck's"
        );
    }

    /// A theory pile is a plan, and a plan holds no cards — so a clear of one moves nothing,
    /// even where the *live* list of the same deck is holding copies of the very same printing.
    /// [`crate::collection_alloc::THEORY_HOLDS_NOTHING`] is the refusal one card at a time; here
    /// it is simply a loop that never runs, and the live deck's custody is what proves it.
    #[test]
    fn clearing_a_theory_pile_moves_no_copies() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 2);
        add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(main),
            None,
            THEORY,
            None,
            2,
        )
        .unwrap();
        file_into_group(&conn, deck.id, "bolt-lea", 2);

        assert_eq!(clear_category(&conn, deck.id, main, THEORY).unwrap(), 2);

        assert_eq!(
            folder_copies(&conn, group_of(&conn, deck.id), "bolt-lea"),
            2,
            "the live deck still holds every copy"
        );
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-lea"), 0);
    }

    /// **A pile of cards nobody owned clears with nothing landing on the desk**, which is the
    /// answer issue #209 could not find: a card added from search is an intention to buy, the
    /// group is the record of which cards are actually behind a list, and an empty group means
    /// there is nothing to give back. It must not refuse and must not invent a copy.
    #[test]
    fn clearing_a_pile_the_reader_never_owned_files_nothing() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        assert_eq!(clear_category(&conn, deck.id, main, LIVE).unwrap(), 4);
        assert_eq!(count(&conn, "collection_entries"), 0);
    }

    /// A whole-list clear empties **every pile of one list**, and the two things it must not reach are
    /// the other list and the columns themselves.
    ///
    /// The theory row is what pins the scope, [`clearing_a_stack_empties_one_pile_of_one_variant`]'s
    /// reason: with `variant` dropped from the `WHERE` the live rows still vanish and nothing else
    /// in the assertion would notice. The `deck_categories` read is the other half — a clear is
    /// not [`crate::deck_meta::delete_category`], and a reader emptying a deck to build it again
    /// keeps the columns they built it in.
    #[test]
    fn clearing_a_deck_empties_the_live_list_and_leaves_the_plan_standing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");

        add(&conn, deck.id, "bolt-lea", main, 2);
        add(&conn, deck.id, "bolt-m10", main, 3);
        add(&conn, deck.id, "bolt-lea", side, 4);
        add_card(
            &conn,
            deck.id,
            "serra-lea",
            Some(main),
            None,
            THEORY,
            None,
            1,
        )
        .unwrap();

        let piles = |c: &Connection| -> Vec<(i64, String)> {
            c.prepare("SELECT id, name FROM deck_categories WHERE deck_id = ?1 ORDER BY id")
                .unwrap()
                .query_map(params![deck.id], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let columns = piles(&conn);
        assert!(columns.len() > 1, "the fixture has piles to lose");

        // Three live rows across two piles: 2 + 3 + 4.
        assert_eq!(clear_variant(&conn, deck.id, LIVE).unwrap(), 9);

        let rows: Vec<(i64, String, i64)> = conn
            .prepare(
                "SELECT category_id, variant, quantity FROM deck_cards
                  WHERE deck_id = ?1 ORDER BY category_id, variant",
            )
            .unwrap()
            .query_map(params![deck.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(main, THEORY.to_owned(), 1)],
            "every live pile went and the plan is untouched"
        );
        assert_eq!(
            piles(&conn),
            columns,
            "a clear is not a delete: every column survives it, empty"
        );
    }

    /// And the same press on the other list, which is not the test above read backwards: the live
    /// rows are what prove the scope this time.
    #[test]
    fn clearing_a_deck_empties_the_plan_and_leaves_the_live_list_standing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");

        add(&conn, deck.id, "bolt-lea", main, 2);
        add(&conn, deck.id, "bolt-lea", side, 1);
        for pile in [main, side] {
            add_card(
                &conn,
                deck.id,
                "serra-lea",
                Some(pile),
                None,
                THEORY,
                None,
                3,
            )
            .unwrap();
        }

        assert_eq!(clear_variant(&conn, deck.id, THEORY).unwrap(), 6);

        let rows: Vec<(i64, String, i64)> = conn
            .prepare(
                "SELECT category_id, variant, quantity FROM deck_cards
                  WHERE deck_id = ?1 ORDER BY category_id, variant",
            )
            .unwrap()
            .query_map(params![deck.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(side, LIVE.to_owned(), 1), (main, LIVE.to_owned(), 2)],
            "the sleeved deck is exactly where it was"
        );
    }

    /// **Copies, never rows** — the number the confirmation quoted and the number `delta` means
    /// in the history. Two printings at 2 and 3 is 5 and not 2, and the two can only be told
    /// apart by a deck holding one printing more than once.
    #[test]
    fn clearing_a_deck_answers_copies_and_not_rows() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 2);
        add(&conn, deck.id, "bolt-m10", main, 3);

        assert_eq!(count(&conn, "deck_cards"), 2, "two rows");
        assert_eq!(
            clear_variant(&conn, deck.id, LIVE).unwrap(),
            5,
            "five cards"
        );
    }

    /// **Emptying a deck gives every copy behind it back**, which is
    /// [`clearing_a_pile_files_its_copies_into_recently_removed`] with the pile boundary taken
    /// away: the group's three copies back two piles, and clearing the list takes all three
    /// where clearing the main deck took two. Left undone they stay filed under a deck that no
    /// longer lists them — invisible, and unavailable to every other deck for ever.
    #[test]
    fn clearing_a_deck_files_every_live_copy_into_recently_removed() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 2);
        add(&conn, deck.id, "bolt-lea", side, 1);
        file_into_group(&conn, deck.id, "bolt-lea", 3);

        assert_eq!(clear_variant(&conn, deck.id, LIVE).unwrap(), 3);

        assert_eq!(
            folder_copies(&conn, removed_group(&conn), "bolt-lea"),
            3,
            "every copy the deck was holding is on the reader's desk"
        );
        assert_eq!(
            folder_copies(&conn, group_of(&conn, deck.id), "bolt-lea"),
            0,
            "and the group is holding nothing for a list that is empty"
        );
    }

    /// A plan holds no cards, so emptying one moves nothing — even where the *live* list of the
    /// same deck is holding copies of the very printing being cleared.
    /// [`crate::collection_alloc::THEORY_HOLDS_NOTHING`] is the refusal one card at a time; here
    /// it is a loop that never runs, and the live deck's custody is what proves it.
    #[test]
    fn clearing_a_planned_deck_moves_no_copies() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 2);
        add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(main),
            None,
            THEORY,
            None,
            2,
        )
        .unwrap();
        file_into_group(&conn, deck.id, "bolt-lea", 2);

        assert_eq!(clear_variant(&conn, deck.id, THEORY).unwrap(), 2);

        assert_eq!(
            folder_copies(&conn, group_of(&conn, deck.id), "bolt-lea"),
            2,
            "the live deck still holds every copy"
        );
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-lea"), 0);
    }

    /// An empty list is not a write, [`clearing_an_empty_stack_writes_nothing_at_all`]'s rule one
    /// scope out — and the deck here is not an empty deck, it is a deck whose *other* list holds
    /// everything. No history, no `updated_at`.
    #[test]
    fn clearing_an_empty_deck_writes_nothing_at_all() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        conn.execute(
            "UPDATE decks SET updated_at = 0 WHERE id = ?1",
            params![deck.id],
        )
        .unwrap();
        let before = crate::deck_audit::list(&conn, deck.id, 50).unwrap().len();

        assert_eq!(clear_variant(&conn, deck.id, THEORY).unwrap(), 0);
        assert_eq!(
            crate::deck_audit::list(&conn, deck.id, 50).unwrap().len(),
            before,
            "a `remove` of zero copies is a history of a change that never happened"
        );
        let touched: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touched, 0, "and the deck did not move");
        assert_eq!(count(&conn, "deck_cards"), 1, "nor did the other list");
    }

    /// **One press, one line of history** — the whole argument for this being a command rather
    /// than a loop over [`clear_category`], asserted rather than left to the reader of the
    /// transaction. `scope` is the field that tells `auditText.ts` this row is about a whole list,
    /// and there is no `category` at all, because a clear of the deck names none.
    #[test]
    fn clearing_a_deck_records_one_history_row_for_the_whole_list() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-m10", main, 2);
        add(&conn, deck.id, "bolt-lea", side, 1);

        assert_eq!(clear_variant(&conn, deck.id, LIVE).unwrap(), 7);

        let history = crate::deck_audit::list(&conn, deck.id, 50).unwrap();
        let removes: Vec<(i64, Option<String>, serde_json::Value)> = history
            .iter()
            .filter(|r| r.kind == crate::deck_audit::REMOVE)
            .map(|r| {
                (
                    r.delta,
                    r.card_id.clone(),
                    serde_json::from_str(&r.payload).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            removes,
            vec![(
                -7,
                None,
                json!({ "action": "clear", "scope": "deck", "cards": 7 })
            )],
            "one row for three piles, naming no card and no category — and `scope` is what \
             separates it from a `Clear stack` row"
        );
    }

    /// A stepper pointed at a row that is not in that category any more is a stale editor,
    /// and the refusal names the category **by the name the user gave it** — an id says
    /// nothing to the person reading it.
    #[test]
    fn adjusting_a_row_that_is_not_in_that_category_names_the_category() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        let err = set_card_quantity(
            &conn,
            deck.id,
            "bolt-lea",
            kind_of(&conn, deck.id, "side"),
            LIVE,
            None,
            1,
        )
        .unwrap_err();

        assert!(err.contains("Sideboard"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");
    }

    #[test]
    fn moving_a_card_between_categories_folds_into_the_target_row() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-lea", side, 1);

        move_card(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            Some(side),
            None,
            LIVE,
            None,
        )
        .unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1, "one row, not two");
        let (category, quantity): (i64, i64) = conn
            .query_row("SELECT category_id, quantity FROM deck_cards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((category, quantity), (side, 5), "four into one");

        // An empty target category is a create, and the identity comes from the moved row
        // rather than from a fresh lookup — so the printing is dropped from `cards` first,
        // which is what the next sync does to a card Scryfall stopped publishing. The row
        // being tidied out of a deck is exactly the row most likely to be orphaned, and a
        // move that needed the id to resolve would refuse it.
        conn.execute("DELETE FROM cards", []).unwrap();

        move_card(
            &conn,
            deck.id,
            "bolt-lea",
            side,
            Some(scratch),
            None,
            LIVE,
            None,
        )
        .unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1);
        let (category, quantity, name, set): (i64, i64, String, String) = conn
            .query_row(
                "SELECT category_id, quantity, name, set_code FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (category, quantity, name.as_str(), set.as_str()),
            (scratch, 5, "Lightning Bolt", "lea"),
            "an orphaned row still moves, still counted and still sayable"
        );
    }

    /// The name arm's whole point: the quick zones' `Auto` names a pile the deck has not got,
    /// and one command makes it and files the card into it. `origin` is **`auto`**, because
    /// `category_for_name` is what made it — a pile nobody asked for, which is exactly what
    /// `grouping.ts`'s `drawsWhenEmpty` reads to keep it off the desk once its last card
    /// leaves. Answering the new id is what lets the caret follow the card there.
    #[test]
    fn a_move_by_name_makes_the_pile_it_names_and_marks_it_auto() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        let to = move_card(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            None,
            Some("Removal"),
            LIVE,
            None,
        )
        .unwrap();

        let (name, origin, kind, active): (String, String, String, i64) = conn
            .query_row(
                "SELECT name, origin, kind, is_active FROM deck_categories WHERE id = ?1",
                params![to],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (name.as_str(), origin.as_str(), kind.as_str(), active),
            ("Removal", "auto", "main", 1),
            "the pile the rule named, recorded as the app's own"
        );
        let (category, quantity): (i64, i64) = conn
            .query_row(
                "SELECT category_id, quantity FROM deck_cards WHERE variant = ?1",
                params![LIVE],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((category, quantity), (to, 4), "every copy went with it");
    }

    /// A pile the reader already made is **found**, not made again — `category_for_name`'s
    /// rule, reached through this arm. So a refile into their own "Removal" keeps that pile's
    /// `user` origin, and the deck grows no second column by the same name.
    #[test]
    fn a_move_by_name_files_into_the_readers_own_pile_and_leaves_its_origin_alone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let theirs = crate::deck_meta::create_category(&conn, deck.id, "Removal").unwrap();
        add(&conn, deck.id, "bolt-lea", main, 4);

        let to = move_card(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            None,
            Some("Removal"),
            LIVE,
            None,
        )
        .unwrap();

        assert_eq!(to, theirs.id, "found, not made");
        let origin: String = conn
            .query_row(
                "SELECT origin FROM deck_categories WHERE id = ?1",
                params![to],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(origin, "user", "a pile they made stays theirs");
        assert_eq!(
            count(&conn, "deck_categories"),
            6,
            "four seeded zones, `main_of`'s own Main deck, and their one Removal — \
             no second column by that name"
        );
    }

    /// **A card the rule files where it already is writes nothing at all**, and the check that
    /// says so runs after the name has been resolved because there is no other moment it could.
    /// `updated_at` must not move: a refile that changed nothing is not an edit to the deck, and
    /// the transaction is dropped rather than committed precisely so the `touch_deck` above it
    /// is rolled back with it.
    #[test]
    fn a_move_by_name_onto_the_cards_own_pile_touches_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        conn.execute(
            "UPDATE decks SET updated_at = 1 WHERE id = ?1",
            params![deck.id],
        )
        .unwrap();
        let audits = count(&conn, "deck_audit");

        let to = move_card(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            None,
            Some("Main deck"),
            LIVE,
            None,
        )
        .unwrap();

        assert_eq!(to, main, "it names the pile the card is in");
        let touched: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touched, 1, "a no-op move does not bump the deck");
        assert_eq!(count(&conn, "deck_audit"), audits, "and writes no history");
    }

    /// Neither half of the target given is the one refusal this arm adds, and it is
    /// [`add_card`]'s `NO_CATEGORY` verbatim — two commands answering the same question answer
    /// it with the same sentence.
    #[test]
    fn a_move_with_no_target_at_all_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        assert_eq!(
            move_card(&conn, deck.id, "bolt-lea", main, None, None, LIVE, None).unwrap_err(),
            NO_CATEGORY,
        );
    }

    /// A move re-files a card; it never promotes a plan into the deck. The two variants hold
    /// the same printing in the same category, and moving one leaves the other exactly where
    /// it was.
    #[test]
    fn a_move_stays_inside_its_own_variant() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(main),
            None,
            THEORY,
            None,
            2,
        )
        .unwrap();

        move_card(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            Some(side),
            None,
            LIVE,
            None,
        )
        .unwrap();

        let rows: Vec<(String, i64, i64)> = conn
            .prepare("SELECT variant, category_id, quantity FROM deck_cards ORDER BY variant, id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(LIVE.to_owned(), side, 4), (THEORY.to_owned(), main, 2)],
            "the live copies moved and the theory row did not follow them"
        );
    }

    /// The card rows of one deck, in a fixed order, as every swap assertion reads them.
    fn category_rows(conn: &Connection, deck_id: i64) -> Vec<(String, i64, i64)> {
        conn.prepare(
            "SELECT card_id, category_id, quantity FROM deck_cards
              WHERE deck_id = ?1 ORDER BY category_id, card_id",
        )
        .unwrap()
        .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// A clock a rollback can be seen against. `decks.updated_at` is whole seconds, so a
    /// touch inside the same second as the setup would be invisible — every "wrote nothing"
    /// assertion here pins it to a value no `unixepoch()` will ever produce twice.
    const UNMOVED: i64 = 1000;

    fn stop_the_clock(conn: &Connection, deck_id: i64) {
        conn.execute(
            "UPDATE decks SET updated_at = ?2 WHERE id = ?1",
            params![deck_id, UNMOVED],
        )
        .unwrap();
    }

    fn touched_at(conn: &Connection, deck_id: i64) -> i64 {
        read_deck(conn, deck_id).unwrap().unwrap().updated_at
    }

    /// The pane's "Use this printing": the copies move to the other printing's row, and the row
    /// is denormalized from the printing swapped **to**.
    #[test]
    fn a_swap_moves_the_quantity_to_the_new_printing_row() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 3);
        // The group holds the **Alpha** copies and the deck is about to run the M10 printing.
        // A Bolt is a Bolt: what the deck holds is matched on oracle id, so the swap below
        // changes which printing is *listed* and nothing about what is owned.
        file_into_group(&conn, deck.id, "bolt-lea", 3);
        stop_the_clock(&conn, deck.id);

        let swapped =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap();

        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        // The other half of what every refusal below pins: a swap *is* an edit, so the deck
        // rises in a gallery that sorts by this column. Without this the whole file could
        // pass with `touch_deck` deleted.
        assert!(
            touched_at(&conn, deck.id) > UNMOVED,
            "a swap moves `updated_at`: the gallery resorts for it"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-m10".to_owned(), main, 3)],
            "one row: the old one is deleted, never left at zero"
        );
        let (set, cn, lang, name): (String, String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang, name FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (set.as_str(), cn.as_str(), lang.as_str(), name.as_str()),
            ("m10", "146", "en", "Lightning Bolt"),
            "the printing and the name come from the `cards` row swapped TO"
        );
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-m10", main),
            3,
            "and the Alpha copies in the group still answer for the M10 row"
        );

        // Any category, an inactive one included — choosing a printing is exactly what a
        // scratchpad is for, and it still counts nothing.
        add(&conn, deck.id, "serra-lea", scratch, 1);
        swap_printing(
            &conn,
            deck.id,
            "serra-lea",
            "serra-8ed",
            scratch,
            LIVE,
            None,
        )
        .unwrap();
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![
                ("serra-8ed".to_owned(), scratch, 1),
                ("bolt-m10".to_owned(), main, 3),
            ],
        );
        assert_eq!(
            owned_of(&conn, deck.id, "serra-8ed", scratch),
            0,
            "a swap in an inactive category is served nothing, before or after"
        );
    }

    /// Two printings of one card in one category is one row, because the grain says so — the
    /// same fold [`add_card`] and [`move_card`] do, reported so the UI can say "folded".
    #[test]
    fn a_swap_onto_an_existing_row_folds_quantities_on_the_grain() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 3);
        add(&conn, deck.id, "bolt-m10", main, 2);
        // The same printing in another category: `category_id` is in the grain, so this row
        // is not in the swap's way and must not collect the copies.
        add(&conn, deck.id, "bolt-m10", side, 1);

        let swapped =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap();

        assert_eq!(
            (swapped.folded, swapped.quantity),
            (true, 5),
            "three into two, and the answer says it folded"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![
                ("bolt-m10".to_owned(), side, 1),
                ("bolt-m10".to_owned(), main, 5),
            ],
        );
    }

    /// Swapping a printing to itself is not an edit: the pane hides the action on the row the
    /// deck already uses, so reaching here is a double-click or a stale list.
    #[test]
    fn a_swap_refuses_the_same_printing_and_writes_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        let err =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-lea", main, LIVE, None).unwrap_err();

        assert!(err.contains("already"), "{err}");
        assert_eq!(
            touched_at(&conn, deck.id),
            UNMOVED,
            "a no-op is not an edit — the gallery does not resort for it"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)]
        );
    }

    /// The [`card_gone`] asymmetry: a swap adjusts a row, and a row that is not in that
    /// category is a stale editor rather than an invitation to create one.
    #[test]
    fn a_swap_of_a_missing_row_says_which_category_it_looked_in() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(
            &conn,
            deck.id,
            "bolt-lea",
            "bolt-m10",
            kind_of(&conn, deck.id, "side"),
            LIVE,
            None,
        )
        .unwrap_err();

        assert!(err.contains("Sideboard"), "the refusal names it: {err}");
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the main-deck row is not what was asked about and is not touched"
        );
        assert_eq!(
            touched_at(&conn, deck.id),
            UNMOVED,
            "and the GONE gate's touch rolled back with the rest"
        );
    }

    /// The printing was clicked out of a *live* printings list, so its absence from `cards`
    /// means one thing: a sync swapped the table out from under the open pane.
    #[test]
    fn a_swap_to_a_printing_the_card_database_lost_blames_the_sync() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        conn.execute("DELETE FROM cards WHERE id = 'bolt-m10'", [])
            .unwrap();
        stop_the_clock(&conn, deck.id);

        let err =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap_err();

        assert!(err.contains("sync"), "{err}");
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the copies stay where they are rather than moving to an id that resolves to \
             nothing"
        );
        assert_eq!(touched_at(&conn, deck.id), UNMOVED);
    }

    /// A swap changes **which printing of a card** a deck plays. Nothing about the statements
    /// it runs would stop it changing *which card* — the quantity is carried across whatever
    /// it is pointed at — so a caller that paired the wrong two ids would turn three Bolts
    /// into three Serra Angels at the same count, silently and with no way back.
    #[test]
    fn a_swap_to_a_different_card_is_refused_and_writes_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        let err =
            swap_printing(&conn, deck.id, "bolt-lea", "serra-lea", main, LIVE, None).unwrap_err();

        assert!(
            err.contains("Lightning Bolt") && err.contains("Serra Angel"),
            "the refusal names both cards, because which two were paired is the whole \
             question: {err}"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the copies stay on the card the reader put in the deck"
        );
        assert_eq!(touched_at(&conn, deck.id), UNMOVED);
    }

    /// The one row the guard must not fence in: a deck card whose printing has left `cards`.
    ///
    /// Its oracle id is unknowable — that is what an orphan *is* — so there is nothing to
    /// compare, and refusing on "cannot tell" would trap the copies on a dead printing that
    /// the reader is trying to escape. The target here is deliberately a **different** card:
    /// with a same-card target the test would pass just as well against a guard that never
    /// skipped, and would prove nothing.
    #[test]
    fn a_swap_off_an_orphaned_printing_is_allowed() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let swapped =
            swap_printing(&conn, deck.id, "bolt-lea", "serra-8ed", main, LIVE, None).unwrap();

        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("serra-8ed".to_owned(), main, 3)],
            "the copies left the dead printing for the one the reader chose"
        );
    }

    #[test]
    fn a_swap_on_a_deleted_deck_answers_gone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        delete_deck(&conn, deck.id).unwrap();

        let err =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap_err();

        assert_eq!(err, GONE, "the same sentence every other card write gives");
    }

    /// The insert, the delete and the history are one write. Failure injected at the last of
    /// the three — the state in between is a deck holding the copies in *neither* row, and it
    /// is not a state anyone can read.
    ///
    /// **The trigger fires on `deck_audit`**, which is the last table the swap writes now that
    /// the allocator is gone; it used to fire on `deck_allocations` for exactly the same
    /// reason. What is being tested is the transaction, not which table aborts it.
    #[test]
    fn a_swap_is_one_transaction() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON deck_audit
             WHEN new.kind = 'swap'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let err =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap_err();

        assert!(err.contains("boom"), "{err}");
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the row the copies came from is still there, and the row they went to is not"
        );
        assert_eq!(touched_at(&conn, deck.id), UNMOVED, "the touch rolled back");

        // Nothing was stranded: with the failure gone the same swap goes through.
        conn.execute_batch("DROP TRIGGER boom;").unwrap();
        let swapped =
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap();
        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
    }

    /// A copy is a copy of the whole deck: its cards in **both** variants, its categories and
    /// its labels as **new rows**, and none of its state.
    ///
    /// The remap is the part that fails invisibly. `deck_cards.category_id` is an id, so a
    /// copy that carried the source's would file the copy's cards under the *original's*
    /// piles — and deleting the original would then take the copy's cards with it through
    /// `ON DELETE CASCADE`. Deleting the source at the end is what proves it did not.
    #[test]
    fn duplicate_copies_categories_labels_and_both_variants_but_not_the_cards_it_holds() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        let label = crate::deck_meta::create_label(&conn, deck.id, "Flex", "amber").unwrap();
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-jp", scratch, 1);
        add_card(
            &conn,
            deck.id,
            "bolt-m10",
            Some(main),
            None,
            THEORY,
            None,
            2,
        )
        .unwrap();
        crate::deck_meta::set_card_label(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            LIVE,
            None,
            Some(label.id),
        )
        .unwrap();
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        assert_ne!(copy.id, deck.id);
        assert_eq!(copy.name, "Burn (copy)");
        assert_eq!(copy.format_key, "modern");
        assert_eq!(
            copy.card_count, 4,
            "live main-deck copies only — the Maybeboard is inactive and the theory row is \
             not the deck"
        );

        // Its categories and labels are its own rows, with its own ids, and every one of them
        // came across.
        let categories: Vec<(String, String, bool)> = conn
            .prepare(
                "SELECT name, kind, is_active FROM deck_categories WHERE deck_id = ?1
                  ORDER BY sort_order, id",
            )
            .unwrap()
            .query_map(params![copy.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            categories,
            vec![
                ("Commander".to_owned(), "commander".to_owned(), true),
                ("Sideboard".to_owned(), "side".to_owned(), true),
                ("Companion".to_owned(), "companion".to_owned(), true),
                ("Maybeboard".to_owned(), "maybe".to_owned(), false),
                ("Main deck".to_owned(), "main".to_owned(), true),
            ],
            "every category, in the order it was in, active flags and all"
        );
        let shared: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories a JOIN deck_categories b ON a.id = b.id
                  WHERE a.deck_id = ?1 AND b.deck_id = ?2",
                params![deck.id, copy.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(shared, 0, "not one category row is shared between the two");

        let cards: Vec<(String, String, String, Option<String>, i64)> = conn
            .prepare(
                "SELECT dc.card_id, dc.variant, cat.name, t.name, dc.quantity
                   FROM deck_cards dc
                   JOIN deck_categories cat ON cat.id = dc.category_id
                   LEFT JOIN deck_labels t ON t.id = dc.label_id
                  WHERE dc.deck_id = ?1 ORDER BY dc.variant, dc.card_id",
            )
            .unwrap()
            .query_map(params![copy.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            cards,
            vec![
                (
                    "bolt-jp".to_owned(),
                    LIVE.to_owned(),
                    "Maybeboard".to_owned(),
                    None,
                    1
                ),
                (
                    "bolt-lea".to_owned(),
                    LIVE.to_owned(),
                    "Main deck".to_owned(),
                    Some("Flex".to_owned()),
                    4
                ),
                (
                    "bolt-m10".to_owned(),
                    THEORY.to_owned(),
                    "Main deck".to_owned(),
                    None,
                    2
                ),
            ],
            "both variants, filed under the copy's own categories, label remapped"
        );

        assert_eq!(
            count(&conn, "collection_entries"),
            1,
            "a copy holds nothing — the original's copies are the original's, and duplicating \
             a row of them would invent cards the reader does not own"
        );
        assert!(
            owned_by_oracle(&conn, copy.id).unwrap().is_empty(),
            "so the copy is a draft, which is what `is_built` used to say"
        );

        // The remap, proven the only way it can be: deleting the source fires the CASCADE on
        // every category and label it owns, and the copy is untouched by it.
        delete_deck(&conn, deck.id).unwrap();
        assert_eq!(
            count(&conn, "deck_cards"),
            3,
            "the copy's three rows survive the original's deletion"
        );
    }

    /// A copy's piles are the source's piles, `origin` included — the duplicate must have the
    /// same *shape* as the deck it was made from.
    ///
    /// This is the fourth write site of a column with only four, and the one that would have
    /// been missed: the INSERT is a re-write of a row that already exists, so leaning on the
    /// column's `DEFAULT 'user'` looks harmless and quietly hands the copy a set of auto piles
    /// that now draw empty. Nothing else in the deck would differ, which is what makes it worth
    /// its own test rather than a line in the one above.
    #[test]
    fn duplicate_carries_each_categorys_origin_rather_than_defaulting_it() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        // `main_of` is `category_for_name`, so this pile is app-made; the other is the reader's.
        let auto = main_of(&conn, deck.id);
        let mine = crate::deck_meta::create_category(&conn, deck.id, "Flex slots").unwrap();
        assert_eq!(origin_of(&conn, auto), "auto", "the premise, not the claim");
        assert_eq!(origin_of(&conn, mine.id), "user");

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        let origins: Vec<(String, String)> = conn
            .prepare(
                "SELECT name, origin FROM deck_categories WHERE deck_id = ?1
                  ORDER BY sort_order, id",
            )
            .unwrap()
            .query_map(params![copy.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            origins,
            vec![
                ("Commander".to_owned(), "user".to_owned()),
                ("Sideboard".to_owned(), "user".to_owned()),
                ("Companion".to_owned(), "user".to_owned()),
                ("Maybeboard".to_owned(), "user".to_owned()),
                ("Main deck".to_owned(), "auto".to_owned()),
                ("Flex slots".to_owned(), "user".to_owned()),
            ],
            "each pile's provenance travels with it"
        );
    }

    /// One category's stored `origin`. The tests above read the column rather than a
    /// [`crate::deck_meta::DeckCategoryRow`], because the column is the fact.
    fn origin_of(conn: &Connection, id: i64) -> String {
        conn.query_row(
            "SELECT origin FROM deck_categories WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn list_decks_counts_the_active_piles_in_the_deck_and_reads_the_cover_artist() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bolt Tribal", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 2);
        add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "commander"),
            1,
        );
        add(
            &conn,
            deck.id,
            "bolt-lea",
            kind_of(&conn, deck.id, "companion"),
            1,
        );
        add(
            &conn,
            deck.id,
            "bolt-lea",
            kind_of(&conn, deck.id, "side"),
            3,
        );
        add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "maybe"),
            7,
        );
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                cover_card_id: Some("bolt-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let old = create_deck(&conn, &input("Old Standard", "standard")).unwrap();
        update_deck(
            &conn,
            old.id,
            &DeckPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let decks = list_decks(&conn).unwrap();

        assert_eq!(
            decks.len(),
            2,
            "an archived deck is listed — the UI separates them"
        );
        assert_eq!(decks[0].id, deck.id, "archived decks sort last");
        assert!(decks[1].archived);
        // The gallery's number and the validation panel's are one definition — the engine's
        // `SIZE_KINDS`, which is `main`, `commander` **and `maybe`**. A companion is the
        // reason this is pinned: EDH calls one "effectively a 101st card", so counting it here
        // would put 101 on the tile of a deck the panel had just called exactly 100.
        //
        // The Maybeboard is out of the number below because it is seeded **inactive**, not
        // because of its kind — the switch decides whether a pile counts at all, and an
        // *active* Maybeboard counts like any other pile. This comment used to say "`main` +
        // `commander` and nothing else", which passes for the wrong reason.
        assert_eq!(
            decks[0].card_count, 3,
            "2 main + 1 commander; the companion, sideboard and Maybeboard are not the deck"
        );
        assert_eq!(decks[0].format_name.as_deref(), Some("Commander"));
        assert_eq!(decks[0].cover_artist.as_deref(), Some("Christopher Rush"));
        assert_eq!(decks[1].card_count, 0);
    }

    /// **A deck row carries the *cover printing's* picture** — the gallery tile's only way to
    /// draw a cover on web or on the phone, where `mtgimg://` is a scheme no browser has.
    ///
    /// It is the one field on `DeckRow` that describes a different row, and the join it comes
    /// off is `LEFT JOIN cards c ON c.id = d.cover_card_id` — the same one `cover_artist` uses.
    /// So the failure this guards is not only an off-by-one: it is also reading the *deck's*
    /// own row, which has no images at all and would answer `None` for every deck, silently,
    /// with a suite full of decks that have no cover anyway.
    ///
    /// **`bolt-m10` is shaped like a `meld` printing and carries all four variants in both
    /// columns, every one a different URL**, which is the only shape where every way of getting
    /// this wrong gives a different answer rather than the right one by luck: face-first
    /// precedence reversed answers `top.webp`, a pair read one column out answers the other
    /// variant's, and a widening back to four answers extra keys that are real URLs.
    ///
    /// Four states, and three of them are the *same* blank frame to a reader: no cover at all,
    /// a cover whose printing has left `cards`, and a printing whose only URL is Scryfall's
    /// error page. `DeckTile` draws all three as "No cover" rather than as a failure.
    #[test]
    fn a_deck_row_carries_the_cover_printings_art() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET
                 image_uris = json_object(
                     'thumb','https://cards.scryfall.io/thumb/top.webp?4',
                     'grid','https://cards.scryfall.io/grid/top.webp?4',
                     'display','https://cards.scryfall.io/display/top.webp?4',
                     'art','https://cards.scryfall.io/art/top.webp?4'),
                 face_image_uris = json_array(json_object(
                     'thumb','https://cards.scryfall.io/thumb/face0.webp?4',
                     'grid','https://cards.scryfall.io/grid/face0.webp?4',
                     'display','https://cards.scryfall.io/display/face0.webp?4',
                     'art','https://cards.scryfall.io/art/face0.webp?4'))
             WHERE id = 'bolt-m10'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE cards SET image_uris = json_object(
                 'art','https://errors.scryfall.com/soon.jpg')
             WHERE id = 'bolt-jp'",
            [],
        )
        .unwrap();

        let cover = |card_id: &str| {
            let deck = create_deck(&conn, &input(card_id, "commander")).unwrap();
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    cover_card_id: Some(card_id.to_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
            deck.id
        };
        let art = cover("bolt-m10");
        let poisoned = cover("bolt-jp");
        let orphan = cover("gone-from-the-corpus");
        let bare = create_deck(&conn, &input("No cover", "commander"))
            .unwrap()
            .id;

        // Through `list_decks` *and* `read_deck`: both go through `deck_row`, and this is what
        // says so rather than the call graph.
        for reader in ["list", "read"] {
            let of = |id: i64| -> Option<BTreeMap<String, String>> {
                if reader == "list" {
                    list_decks(&conn)
                        .unwrap()
                        .into_iter()
                        .find(|d| d.id == id)
                        .unwrap()
                        .image_uris
                } else {
                    read_deck(&conn, id).unwrap().unwrap().image_uris
                }
            };

            let uris = of(art).unwrap_or_else(|| panic!("the cover has a picture ({reader})"));
            assert_eq!(
                uris[crate::image_uri::ART_VARIANT],
                "https://cards.scryfall.io/art/face0.webp?4",
                "the tile's crop, from the face and not the top-level blob ({reader})"
            );
            assert_eq!(
                uris[crate::image_uri::LIST_VARIANT],
                "https://cards.scryfall.io/display/face0.webp?4",
                "and the card, at its own offset ({reader})"
            );
            // Spelled out rather than read off `LIST_VARIANTS`: an assertion that reads the
            // constant it is fencing can never fail when that constant moves, and the cover
            // printing here carries all four variants, so a widening comes back as real URLs
            // under real keys. A widening has to come here and say so.
            assert_eq!(
                uris.keys().map(String::as_str).collect::<Vec<_>>(),
                ["art", "display"],
                "what a list row carries and nothing else ({reader})"
            );

            assert_eq!(
                of(poisoned),
                None,
                "an error page is a gap, not a cover ({reader})"
            );
            assert_eq!(
                of(orphan),
                None,
                "a cover whose printing has left `cards` draws nothing ({reader})"
            );
            assert_eq!(of(bare), None, "and a deck with no cover ({reader})");
        }
    }

    /// The gallery's caption is about the deck the user has, and two things are not it: a
    /// **theory** row, which is a plan, and a row in a category that has been switched
    /// **off**, which counts toward nothing at all. Neither is a kind check — a main-deck
    /// category the user deactivated stops counting exactly like the Maybeboard does.
    #[test]
    fn the_gallery_count_reads_only_live_rows_in_active_categories() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add_card(
            &conn,
            deck.id,
            "bolt-m10",
            Some(main),
            None,
            THEORY,
            None,
            40,
        )
        .unwrap();

        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            4,
            "the theory list is a plan and is counted on no tile"
        );

        crate::deck_meta::set_category_active(&conn, main, false).unwrap();
        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            0,
            "and a `main` category switched off counts toward nothing, kind or no kind"
        );

        crate::deck_meta::set_category_active(&conn, main, true).unwrap();
        assert_eq!(read_deck(&conn, deck.id).unwrap().unwrap().card_count, 4);
    }

    /// **The switch decides whether a pile counts at all; the kind decides only whether it is
    /// played *beside* the deck or *in* it, and only `side` and `companion` are beside it.**
    ///
    /// So an active Maybeboard is part of the deck's size and an inactive one is not — the
    /// same sentence as every other category, which is the point. The alternative was measured
    /// and rejected: with `maybe` left out of the size list, an active Maybeboard was inside
    /// the format's card pool and inside the binder's reservations but outside the size, so a
    /// second Sol Ring in one raised a singleton error under a figure that still read 100.
    ///
    /// Paired with `SIZE_KINDS` in `engine.ts`, which is these three words and must stay them:
    /// [`DeckRow::card_count`] and the validation panel answer one question, and two answers to
    /// it is the bug this whole definition exists to prevent.
    #[test]
    fn an_active_maybeboard_is_part_of_the_deck_and_an_inactive_one_is_not() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-jp", scratch, 3);

        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            4,
            "the Maybeboard is seeded off, so it counts toward nothing — including the size"
        );

        crate::deck_meta::set_category_active(&conn, scratch, true).unwrap();

        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            7,
            "switched on, it is a pile played *in* the deck like any other, so it sizes"
        );

        // And the two kinds that really are played beside the deck stay out either way —
        // CR 100.4a for the sideboard, and EDH's "effectively a 101st card" for the companion.
        add(
            &conn,
            deck.id,
            "serra-lea",
            kind_of(&conn, deck.id, "side"),
            15,
        );
        add(
            &conn,
            deck.id,
            "serra-8ed",
            kind_of(&conn, deck.id, "companion"),
            1,
        );
        assert_eq!(read_deck(&conn, deck.id).unwrap().unwrap().card_count, 7);
    }

    #[test]
    fn a_card_id_that_does_not_resolve_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = add_card(
            &conn,
            deck.id,
            "no-such-card",
            Some(main_of(&conn, deck.id)),
            None,
            LIVE,
            None,
            1,
        )
        .unwrap_err();

        assert!(err.contains("no-such-card"), "{err}");
        assert!(err.contains("card database"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    /// `format_key` carries no foreign key on purpose — `format_specs` is re-seeded with
    /// `INSERT OR REPLACE` by every migration that corrects a cell — so the check lives
    /// here, in words, at the two moments a key can be chosen.
    #[test]
    fn a_deck_needs_a_name_and_a_format_the_specs_know() {
        let conn = seeded();

        let err = create_deck(&conn, &input("Burn", "kitchen-table")).unwrap_err();
        assert!(err.contains("kitchen-table"), "{err}");
        assert_eq!(count(&conn, "decks"), 0);

        let err = create_deck(&conn, &input("   ", "modern")).unwrap_err();
        assert!(err.contains("name"), "{err}");
        assert_eq!(count(&conn, "decks"), 0);

        // An omitted format is the table's own default, not a refusal.
        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(deck.format_key, DEFAULT_FORMAT);

        let err = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                format_key: Some("kitchen-table".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("kitchen-table"), "{err}");

        let renamed = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                name: Some("Burn v2".to_owned()),
                format_key: Some("modern".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Burn v2");
        assert_eq!(
            (renamed.format_key.as_str(), renamed.format_name.as_deref()),
            ("modern", Some("Modern"))
        );
    }

    /// A database nobody has made a deck in has no answer, and saying so is the point: the
    /// dialog's fallback is Commander, which is a display decision this function must not make
    /// (and `DEFAULT_FORMAT`, the one SQL would supply, is not it).
    #[test]
    fn a_database_with_no_decks_in_it_remembers_no_format() {
        let conn = seeded();
        assert_eq!(last_deck_format(&conn), None);
    }

    /// The whole feature: the New deck dialog opens on the format the reader last built in, and
    /// the *last* one wins rather than the first.
    #[test]
    fn a_create_remembers_its_format_and_the_next_one_overwrites_it() {
        let conn = seeded();

        create_deck(&conn, &input("Burn", "modern")).unwrap();
        assert_eq!(last_deck_format(&conn).as_deref(), Some("modern"));

        create_deck(&conn, &input("Bolt Tribal", "commander")).unwrap();
        assert_eq!(last_deck_format(&conn).as_deref(), Some("commander"));
    }

    /// The **validated** key is what is remembered, not the input. A blank `formatKey` makes a
    /// `casual` deck (`decks.format_key`'s DDL default, through `valid_format`), so remembering
    /// the empty string would open the next dialog on nothing at all.
    #[test]
    fn a_blank_format_is_remembered_as_the_one_the_deck_actually_got() {
        let conn = seeded();

        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(deck.format_key, DEFAULT_FORMAT);
        assert_eq!(last_deck_format(&conn).as_deref(), Some(DEFAULT_FORMAT));
    }

    /// The write is inside the transaction, and this is what pins it there: a create that is
    /// refused leaves the previous answer standing rather than half-recording an intention. Both
    /// refusals, because one is raised before the transaction opens (`valid_format`) and one
    /// before that (`valid_name`) — and a future reordering must not make either land.
    #[test]
    fn a_refused_create_remembers_nothing() {
        let conn = seeded();
        create_deck(&conn, &input("Burn", "modern")).unwrap();

        create_deck(&conn, &input("Kitchen", "kitchen-table")).unwrap_err();
        create_deck(&conn, &input("   ", "commander")).unwrap_err();

        assert_eq!(
            last_deck_format(&conn).as_deref(),
            Some("modern"),
            "a refused create must leave the last real one's format standing"
        );
        assert_eq!(count(&conn, "decks"), 1);
    }

    /// Three preferences share `app_meta` now, and each has to survive the others being written.
    /// `card.rs`'s `the_grouping_row_and_the_marketplace_row_do_not_collide` makes the same claim
    /// about the two that were there first; this one is here because [`K_LAST_DECK_FORMAT`] is
    /// the odd key out — it is written from this module, as a *side effect* of a create rather
    /// than by a setter of its own, so nothing in `card.rs` or `marketplace.rs` is in a position
    /// to notice it. A write that reached for the wrong key, or one that replaced the table's
    /// contents instead of upserting a row into it, would read as the reader's printing grouping
    /// and marketplace quietly reverting to their defaults the first time they made a deck —
    /// two settings on two other screens, so nothing near the create would say so.
    #[test]
    fn a_create_leaves_the_other_app_meta_rows_standing() {
        let conn = seeded();
        crate::card::store_group_by(&conn, "set").unwrap();
        crate::marketplace::store(&conn, "cardmarket").unwrap();

        create_deck(&conn, &input("Burn", "modern")).unwrap();

        assert_eq!(last_deck_format(&conn).as_deref(), Some("modern"));
        assert_eq!(crate::card::stored_group_by(&conn), "set");
        assert_eq!(crate::marketplace::stored(&conn), "cardmarket");
    }

    /// The search column's own row, in all four states a read can find it in — and the point of
    /// the last two is that a database this build cannot make sense of is still a database the
    /// editor opens. `"true"` is the spelling a reader hand-editing the table would reach for
    /// first, which is exactly why it has to read as the default rather than as `true`: the
    /// column stores `"1"`/`"0"` and nothing else, and a second accepted spelling would be a
    /// second thing to keep in step.
    #[test]
    fn the_search_column_state_survives_a_round_trip_and_falls_back_otherwise() {
        let conn = seeded();

        assert!(
            stored_deck_search_open(&conn),
            "a database nobody has expressed a preference in opens the column"
        );

        store_deck_search_open(&conn, false).unwrap();
        assert!(!stored_deck_search_open(&conn));

        store_deck_search_open(&conn, true).unwrap();
        assert!(stored_deck_search_open(&conn));

        crate::app_meta::set_app_meta(&conn, K_DECK_SEARCH_OPEN, "true").unwrap();
        assert_eq!(
            stored_deck_search_open(&conn),
            DEFAULT_DECK_SEARCH_OPEN,
            "a value this build does not write reads as the default"
        );
    }

    /// The fourth `app_meta` key, held against the three that were there first — the same claim
    /// `a_create_leaves_the_other_app_meta_rows_standing` makes one row over, and it is worth
    /// making again in this direction: a disclosure is pressed far more often than a deck is
    /// created, so a write here that replaced the table rather than upserting into it would take
    /// the reader's marketplace, their printing grouping *and* their New deck format with it,
    /// every time they opened the search.
    #[test]
    fn the_search_column_write_leaves_the_other_app_meta_rows_standing() {
        let conn = seeded();
        crate::card::store_group_by(&conn, "set").unwrap();
        crate::marketplace::store(&conn, "cardmarket").unwrap();
        create_deck(&conn, &input("Burn", "modern")).unwrap();

        store_deck_search_open(&conn, false).unwrap();

        assert_eq!(last_deck_format(&conn).as_deref(), Some("modern"));
        assert_eq!(crate::card::stored_group_by(&conn), "set");
        assert_eq!(crate::marketplace::stored(&conn), "cardmarket");
    }

    /// A new deck is born with the four predefined categories, because a deck that exists but
    /// cannot be filed into anything is a state nothing downstream expects — the v8 migration
    /// only ever seeded these for decks that existed *at* the migration.
    #[test]
    fn a_new_deck_is_born_with_its_predefined_categories() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let rows: Vec<(String, String, bool)> = conn
            .prepare(
                "SELECT kind, name, is_active FROM deck_categories WHERE deck_id = ?1
                  ORDER BY sort_order, id",
            )
            .unwrap()
            .query_map(params![deck.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("commander".to_owned(), "Commander".to_owned(), true),
                ("side".to_owned(), "Sideboard".to_owned(), true),
                ("companion".to_owned(), "Companion".to_owned(), true),
                ("maybe".to_owned(), "Maybeboard".to_owned(), false),
            ],
            "`schema::PREDEFINED_CATEGORIES`, with the Maybeboard alone switched off — and no \
             `main` row, because a deck may own any number of those and predefines none"
        );
    }

    /// One INSERT makes a whole deck, so the deck the user described either exists as they
    /// described it or does not exist at all — the reason [`DeckInput`] is wide rather than the
    /// three fields it was.
    ///
    /// `cover_kind` is the one thing that is **not** settable here, and the assertion says so:
    /// it keeps its DDL default whatever `cover_card_id` holds, because the other word names a
    /// file written against an id this statement is still in the middle of making.
    #[test]
    fn a_create_carrying_every_field_reads_back_with_all_of_them() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let folder = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;

        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "  Burn  ".to_owned(),
                format_key: "modern".to_owned(),
                game_key: "paper".to_owned(),
                description: Some("Fast red".to_owned()),
                notes: Some("Skewers over Bolts in game two.".to_owned()),
                cover_card_id: Some("bolt-lea".to_owned()),
                folder_id: Some(folder),
                theory_enabled: Some(true),
            },
        )
        .unwrap();

        assert_eq!(deck.name, "Burn", "still trimmed by `valid_name`");
        assert_eq!(deck.format_key, "modern");
        assert_eq!(deck.description.as_deref(), Some("Fast red"));
        assert_eq!(
            deck.notes.as_deref(),
            Some("Skewers over Bolts in game two."),
            "the notebook and the caption are two columns and both arrive at create"
        );
        assert_eq!(deck.cover_card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(
            deck.cover_artist.as_deref(),
            Some("Christopher Rush"),
            "and the readback joins `cards` for the credit an art crop owes"
        );
        assert_eq!(
            deck.cover_kind, COVER_CARD_ART,
            "a custom picture is written against a deck id, so create cannot ask for one"
        );
        assert_eq!(deck.folder_id, Some(folder));
        assert!(deck.theory_enabled);
        // And the four categories are still seeded in the same transaction — the widened
        // INSERT is one bigger statement inside it, not a second path around it.
        assert_eq!(count(&conn, "deck_categories"), 4);
    }

    /// `folder_id: None` at create is **the root of the tree**, and it earns a test of its own
    /// because the same `None` means the opposite thing one struct over:
    /// [`DeckPatch::folder_id`] is written `coalesce(?n, folder_id)`, which reads a bound NULL
    /// as "leave it", so no patch can un-file a deck ([`set_folder`] is that command). An INSERT
    /// has no previous value to leave alone. A reader who has learned the patch rule will assume
    /// it applies here.
    #[test]
    fn a_deck_created_with_no_folder_is_at_the_top_level() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let commander = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;
        let filed = create_deck(
            &conn,
            &DeckInput {
                name: "Sisay".to_owned(),
                format_key: "commander".to_owned(),
                folder_id: Some(commander),
                ..Default::default()
            },
        )
        .unwrap();

        let root = create_deck(&conn, &input("Burn", "modern")).unwrap();

        assert_eq!(
            root.folder_id, None,
            "no folder chosen is the root of the tree, not `leave it`"
        );
        assert_eq!(
            filed.folder_id,
            Some(commander),
            "and a folder that was chosen is kept"
        );
        // A real NULL in the column, not a 0 that a later read would resolve to a folder.
        let stored: Option<i64> = conn
            .query_row(
                "SELECT folder_id FROM decks WHERE id = ?1",
                params![root.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, None);
    }

    /// A folder id naming nothing is refused by the **real foreign key** —
    /// `decks.folder_id REFERENCES deck_folders(id)`, enforced because `decks` and
    /// `deck_folders` are both user tables and neither is dropped by a sync — rather than in
    /// words the way [`set_folder`] refuses one. No sentence is owed here: the folder select is
    /// filled from the live folder list, so an id that resolves to nothing is a caller's bug and
    /// not something a user typed. `foreign_keys` is ON, as `db::open` always sets it.
    #[test]
    fn creating_a_deck_in_a_folder_that_is_not_there_is_refused_by_the_foreign_key() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        let err = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                format_key: "modern".to_owned(),
                folder_id: Some(404),
                ..Default::default()
            },
        )
        .unwrap_err();

        assert!(err.to_lowercase().contains("foreign key"), "{err}");
        // And the whole deck went with the refusal: the categories and the history line are
        // written inside the same transaction, so there is no half-made deck to find.
        assert_eq!(count(&conn, "decks"), 0);
        assert_eq!(count(&conn, "deck_categories"), 0);
        assert_eq!(count(&conn, "deck_audit"), 0);
    }

    /// Theory at create **sets the column and seeds nothing**, which is not what
    /// [`DeckPatch::theory_enabled`] does: flipping that switch on an existing deck copies its
    /// live list into an empty theory one, because an empty plan beside a full deck reads as
    /// data loss rather than as a blank page. A deck one statement old has no live list, so
    /// there is nothing that could read as anything.
    ///
    /// The second half is the half that makes the first honest: the patch route still seeds, so
    /// this is a create that has nothing to copy and not a seeding rule that was removed.
    #[test]
    fn theory_at_create_enables_the_list_and_seeds_no_cards() {
        let conn = seeded();
        let theory_rows = |deck_id: i64| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM deck_cards WHERE deck_id = ?1 AND variant = ?2",
                params![deck_id, THEORY],
                |r| r.get(0),
            )
            .unwrap()
        };

        let born_on = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                format_key: "modern".to_owned(),
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(born_on.theory_enabled);
        assert_eq!(
            count(&conn, "deck_cards"),
            0,
            "a deck one statement old has no live cards to seed from"
        );
        // Cards added afterwards stay in the variant they were added to: enabling at create
        // hooks nothing up to `deck_theory::seed_from_live`.
        add(&conn, born_on.id, "bolt-lea", main_of(&conn, born_on.id), 4);
        assert_eq!(theory_rows(born_on.id), 0);

        // Meanwhile the patch route seeds exactly as it always did.
        let switched_on = create_deck(&conn, &input("Angels", "modern")).unwrap();
        add(
            &conn,
            switched_on.id,
            "serra-lea",
            main_of(&conn, switched_on.id),
            1,
        );
        update_deck(
            &conn,
            switched_on.id,
            &DeckPatch {
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(theory_rows(switched_on.id), 1, "untouched by any of this");
    }

    /// **Being born is one event however many fields it was born with.** [`update_deck`] writes
    /// one history row per field that actually moved, because each of those is a change to
    /// something that already had a value; a create has no `from` side to compare against, and a
    /// drawer that opened with seven lines under one press would read as a deck somebody spent
    /// an evening editing. `deck_audit`'s `every_deck_write_leaves_exactly_one_audit_row` counts
    /// the same single row for `deck_create`.
    #[test]
    fn a_create_carrying_every_field_still_writes_one_history_row() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let folder = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;

        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                format_key: "modern".to_owned(),
                game_key: "paper".to_owned(),
                description: Some("Fast red".to_owned()),
                notes: Some("Skewers over Bolts in game two.".to_owned()),
                cover_card_id: Some("bolt-lea".to_owned()),
                folder_id: Some(folder),
                theory_enabled: Some(true),
            },
        )
        .unwrap();

        let history = crate::deck_audit::list(&conn, deck.id, 10).unwrap();
        assert_eq!(history.len(), 1, "one create, one line");
        assert_eq!(history[0].kind, crate::deck_audit::DECK);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&history[0].payload).unwrap(),
            json!({ "field": "name", "from": null, "to": "Burn" }),
            "the name, with the null `from` that only a create has — and no `folder` row \
             either, which `set_folder` and a folder patch both write"
        );
    }

    /// A deck delete is a real user deletion — the decks are the user's to destroy — and
    /// the CASCADEs take the cards, the categories and the deck's own group with it. What it
    /// never destroys is a card the reader owns: the copies in the group are re-filed into
    /// `Recently removed` first, which
    /// `deleting_a_deck_refiles_its_cards_into_recently_removed_one_at_a_time` is about.
    ///
    /// **Nor the labels, since schema v21, and that is the change rather than a leak.** A label
    /// used to carry `deck_id … ON DELETE CASCADE` and went with the deck that made it, which
    /// was right while it belonged to one. It belongs to the app now: deleting a deck that
    /// happened to be where "Cut candidate" was first typed must not take the label off the
    /// nine other decks wearing it, so a delete unclaims the label here (through `deck_cards`)
    /// and leaves it standing. Clearing *every* deck is the case that would otherwise strand
    /// them, and `reset::clear_decks` sweeps the table by hand for exactly that reason.
    #[test]
    fn deleting_a_deck_takes_its_cards_and_deleting_it_twice_still_succeeds() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 4);
        crate::deck_meta::create_label(&conn, deck.id, "Flex", "amber").unwrap();
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        delete_deck(&conn, deck.id).unwrap();

        assert_eq!(count(&conn, "decks"), 0);
        assert_eq!(count(&conn, "deck_cards"), 0);
        assert_eq!(count(&conn, "deck_categories"), 0);
        assert_eq!(
            count(&conn, "deck_labels"),
            1,
            "the label outlives the deck it was made in — see this test's doc"
        );
        assert_eq!(
            count(&conn, "collection_entries"),
            1,
            "the copies are still owned"
        );

        delete_deck(&conn, deck.id).expect("a deck that is already gone is gone");
    }

    /// **Every deck made from here on has a group**, `ensure_predefined_categories`' precedent
    /// one table over — schema v25 gave every deck that already existed one, and this is what
    /// keeps the invariant true for the ones made afterwards. Named after the deck, because the
    /// name is the only thing a reader has to find it by in the folder tree.
    #[test]
    fn a_new_deck_is_born_with_its_own_collection_group() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let (name, kind): (String, String) = conn
            .query_row(
                "SELECT name, kind FROM collection_folders WHERE deck_id = ?1",
                params![deck.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Burn");
        assert_eq!(kind, "deck");
    }

    /// The group's name is a **snapshot** of `decks.name` and nothing in the schema keeps the
    /// two in step, so the rename is what does. Without this the folder tree goes on showing a
    /// name the gallery has not used for months.
    #[test]
    fn renaming_a_deck_renames_its_collection_group() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                name: Some("  Mono Red  ".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM collection_folders WHERE deck_id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            name, "Mono Red",
            "the trimmed name the deck itself got, not the raw one"
        );
    }

    /// **Deleting a deck does not delete the cards in it.** They are copies the reader owns, so
    /// they go to `Recently removed` — by hand, before `collection_folders.deck_id`'s CASCADE
    /// takes the group and `collection_entries.folder_id`'s SET NULL scatters them to the root.
    ///
    /// **One at a time, through [`crate::collection_folders::refile_entry`]**, which is
    /// `collection_folders::delete_folder`'s rule and is what makes the destination a *merge*.
    /// The shape that reaches it here is a printing already sitting in `Recently removed` —
    /// which is every second deck delete of a card the reader plays in two decks — and a bulk
    /// `UPDATE … SET folder_id` would answer it with `UNIQUE constraint failed: index
    /// 'idx_collection_grain'`, the folder still standing and nothing moved.
    #[test]
    fn deleting_a_deck_refiles_its_cards_into_recently_removed_and_merges() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let removed = removed_group(&conn);
        // A copy of the same printing that a previous delete already left in the holding area.
        let waiting = own(&conn, "bolt-lea", 1);
        crate::collection_folders::refile_entry(&conn, waiting, Some(removed)).unwrap();

        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        file_into_group(&conn, deck.id, "bolt-lea", 2);
        file_into_group(&conn, deck.id, "bolt-m10", 1);
        assert_eq!(count(&conn, "collection_entries"), 3);

        delete_deck(&conn, deck.id).unwrap();

        let held: Vec<(String, i64)> = conn
            .prepare(
                "SELECT card_id, quantity FROM collection_entries
                  WHERE folder_id = ?1 ORDER BY card_id",
            )
            .unwrap()
            .query_map(params![removed], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            held,
            vec![("bolt-lea".to_owned(), 3), ("bolt-m10".to_owned(), 1)],
            "the deck's Alpha Bolts folded into the one already waiting, and the M10 row moved"
        );
        assert_eq!(
            count(&conn, "collection_entries"),
            2,
            "three rows became two, and not one copy was lost"
        );
        assert_eq!(
            count(&conn, "collection_folders"),
            1,
            "and the group went with the deck — only `Recently removed` is left"
        );
    }

    /// The other half of the same press: a group holding **nothing** is a delete with no
    /// re-filing to do at all, and a deck that is already gone is still a success.
    #[test]
    fn deleting_an_empty_deck_twice_still_succeeds() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        delete_deck(&conn, deck.id).unwrap();
        assert_eq!(count(&conn, "collection_entries"), 0);
        delete_deck(&conn, deck.id).expect("a deck that is already gone is gone");
    }

    /// A copy is a **draft**: it lists the same cards and holds none of them, which is what
    /// `is_built` used to say and what an empty group says now.
    #[test]
    fn a_duplicate_gets_its_own_empty_group() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 4);
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        let group = group_of(&conn, copy.id);
        assert_ne!(group, group_of(&conn, deck.id));
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM collection_entries WHERE folder_id = ?1",
                params![group],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0,
            "a copy holds nothing"
        );
        assert_eq!(
            owned_by_oracle(&conn, deck.id).unwrap().get("o1"),
            Some(&4),
            "and the original still holds everything it held"
        );
    }

    /// **Archiving is a flag and not a delete**, so it touches the group not at all — the
    /// argument schema v25's backfill makes when it gives archived decks a group like every
    /// other deck. An archived deck still holds its cards.
    #[test]
    fn archiving_a_deck_leaves_its_group_and_its_cards_alone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 4);
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(owned_by_oracle(&conn, deck.id).unwrap().get("o1"), Some(&4));
    }

    /// **The cover survives a duplicate, and it survives as a card id.**
    ///
    /// Five tests stood here while a cover could also be a *file*: the delete removing
    /// `<id>.webp`, the two kinds taking turns, a set for a deck that is gone writing nothing,
    /// and the duplicate's own file plus its fallback. Custom covers went on 2026-08-31 and all
    /// five went with them. What is worth keeping is the half that is now the whole feature --
    /// `cover_card_id` is a column like any other and the `INSERT ... SELECT` carries it -- plus
    /// the assertion that the statement no longer writes the **retired** `cover_image_path`,
    /// which is the one thing about that statement a reader could get wrong by putting the old
    /// column list back.
    ///
    /// **The source's path is seeded by hand, and without that line this test cannot fail.**
    /// Nothing writes `cover_image_path` any more, so a freshly created deck's is NULL, a
    /// statement that copied the column would copy NULL, and the assertion below would pass
    /// against exactly the defect it exists to catch. The seeded value is what an upgraded
    /// database really holds: the rung flips `cover_kind` and deliberately leaves this column
    /// where it is, so every deck that ever had a custom cover still carries an absolute path
    /// to a file nothing serves.
    #[test]
    fn a_duplicate_carries_the_cover_card_and_writes_no_retired_path() {
        let conn = seeded();
        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                format_key: "modern".to_owned(),
                cover_card_id: Some("bolt-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE decks SET cover_image_path = ?2 WHERE id = ?1",
            params![deck.id, "D:\\app\\data\\covers\\1.webp"],
        )
        .unwrap();

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        assert_eq!(copy.cover_card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(copy.cover_kind, COVER_CARD_ART);
        let stored: Option<String> = conn
            .query_row(
                "SELECT cover_image_path FROM decks WHERE id = ?1",
                params![copy.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            stored, None,
            "`cover_image_path` is retired: nothing writes it, a copy included"
        );
        // And the source keeps what it had: phase one stops *writing* the column, it does not
        // clear it. Dropping it is a later rung's, once every device is past this one.
        let source: Option<String> = conn
            .query_row(
                "SELECT cover_image_path FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(source.is_some(), "the source's retired path is left alone");
    }

    /// **A `custom` row arriving over sync is repaired by the next card the reader picks**, and
    /// this is the only path left that writes `decks.cover_kind` at all.
    ///
    /// `cover_kind` is a synced field, and the rung that flips every local `custom` row to
    /// `card_art` cannot reach a device that has not taken it -- so that device can push a
    /// `custom` row here afterwards. Seeded by hand for exactly that reason: no command in this
    /// crate can produce this state any more, which is what makes it worth pinning rather than
    /// leaving to the migration's own test.
    ///
    /// The history line is the second half. Its `from` side says `custom` rather than naming
    /// the card the tile had already fallen back to -- see [`cover_value`].
    #[test]
    fn a_synced_in_custom_row_is_put_back_on_card_art_by_picking_a_card() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        conn.execute(
            "UPDATE decks SET cover_kind = ?2 WHERE id = ?1",
            params![deck.id, COVER_CUSTOM],
        )
        .unwrap();

        let back = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                cover_card_id: Some("bolt-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(back.cover_kind, COVER_CARD_ART);
        assert_eq!(back.cover_card_id.as_deref(), Some("bolt-lea"));
        let payload: String = conn
            .query_row(
                "SELECT payload FROM deck_audit
                  WHERE deck_id = ?1 AND kind = 'deck' ORDER BY id DESC LIMIT 1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            json!({ "field": "cover", "from": "custom", "to": "bolt-lea" })
        );
    }

    /// The one thing a [`DeckPatch`] cannot say: **put this deck back at the root**. `None` is
    /// root here because there is nothing else it could be — the whole reason this is a command
    /// rather than a patch field.
    #[test]
    fn a_deck_can_be_filed_and_unfiled() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let commander = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;

        let filed = set_folder(&conn, deck.id, Some(commander)).unwrap();
        assert_eq!(filed.folder_id, Some(commander));

        // The patch route can move it between folders but never out of one: `coalesce` reads a
        // bound NULL as "leave it", which is what this command exists to work around.
        let still_filed = update_deck(&conn, deck.id, &DeckPatch::default()).unwrap();
        assert_eq!(still_filed.folder_id, Some(commander));

        let unfiled = set_folder(&conn, deck.id, None).unwrap();
        assert_eq!(unfiled.folder_id, None, "back at the root of the tree");

        // Both moves are in the history, and the root one says so with a null rather than an
        // empty string — "filed nowhere" and "filed under a folder called nothing" are
        // different, and only one of them is a state the app can produce.
        let history = crate::deck_audit::list(&conn, deck.id, 10).unwrap();
        let folders: Vec<serde_json::Value> = history
            .iter()
            .filter(|r| r.kind == crate::deck_audit::FOLDER)
            .map(|r| serde_json::from_str(&r.payload).unwrap())
            .collect();
        assert_eq!(
            folders,
            vec![
                json!({ "action": "move", "folder": null }),
                json!({ "action": "move", "folder": "Commander" }),
            ]
        );
    }

    /// A stale folder id is refused in words, not left to a foreign key that may not even be
    /// enforced on this connection — and a deck that is not there is [`GONE`], as everywhere.
    #[test]
    fn filing_a_deck_somewhere_that_is_not_there_is_refused_by_name() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        assert_eq!(
            set_folder(&conn, deck.id, Some(404)).unwrap_err(),
            crate::deck_meta::FOLDER_GONE
        );
        assert_eq!(set_folder(&conn, 404, None).unwrap_err(), GONE);
        // A refused filing wrote nothing, history included.
        let filed: Option<i64> = conn
            .query_row(
                "SELECT folder_id FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filed, None);
    }

    /// Re-filing a deck where it already is changed nothing, so it records nothing —
    /// [`update_deck`]'s rule, and the reason a settings dialog that saves an untouched form
    /// does not fill the drawer with moves nobody made.
    #[test]
    fn filing_a_deck_where_it_already_is_records_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let folder = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;
        set_folder(&conn, deck.id, Some(folder)).unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        set_folder(&conn, deck.id, Some(folder)).unwrap();

        assert_eq!(count(&conn, "deck_audit"), 0);
    }

    /// The two words `decks.cover_kind`'s CHECK allows, walked against the live column — the
    /// discipline `schema::CATEGORY_KINDS` gets, for the same reason: a typo in either constant
    /// is otherwise a `CHECK constraint failed` on the one write nobody exercises by hand.
    ///
    /// **Both words, though only one is written any more.** [`COVER_CUSTOM`] is retired — see
    /// its own doc — and the column still accepts it, because retiring the *feature* and
    /// narrowing the *DDL* are two rungs and this is the first. A row carrying it can still
    /// arrive over sync, and `apply/` writes what it is given: the day this assertion stops
    /// passing is the day such a row is refused at the far end of a sync with nothing in the
    /// app able to say why.
    #[test]
    fn the_cover_kinds_are_the_ones_the_column_allows() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        for kind in [COVER_CARD_ART, COVER_CUSTOM] {
            conn.execute(
                "UPDATE decks SET cover_kind = ?2 WHERE id = ?1",
                params![deck.id, kind],
            )
            .unwrap_or_else(|e| panic!("`{kind}` must be a cover kind, but: {e}"));
        }
        assert!(
            conn.execute(
                "UPDATE decks SET cover_kind = 'gradient' WHERE id = ?1",
                params![deck.id],
            )
            .is_err(),
            "and nothing else is"
        );
    }

    /// The gallery sorts by `decks.updated_at`, so a deck that was edited has to rise —
    /// and the same statement is what tells a card write that the deck it names exists.
    #[test]
    fn every_card_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        // `unixepoch()` has one-second resolution, so the clock is moved back rather than
        // waited on.
        let backdate = |conn: &Connection| {
            conn.execute(
                "UPDATE decks SET updated_at = 0 WHERE id = ?1",
                params![deck.id],
            )
            .unwrap();
        };
        let updated_at = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap()
        };

        backdate(&conn);
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert!(updated_at(&conn) > 0, "the add moved the deck");

        backdate(&conn);
        set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, None, 2).unwrap();
        assert!(updated_at(&conn) > 0, "so does the stepper");

        backdate(&conn);
        move_card(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            Some(side),
            None,
            LIVE,
            None,
        )
        .unwrap();
        assert!(updated_at(&conn) > 0, "and so does the move");

        // The same statement is the existence check: a stale deck id from a gallery that
        // has not refreshed is a sentence, never a foreign-key error.
        let err = add_card(
            &conn,
            deck.id + 999,
            "bolt-lea",
            Some(main),
            None,
            LIVE,
            None,
            1,
        )
        .unwrap_err();
        assert_eq!(err, GONE);
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");
    }

    #[test]
    fn deck_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckRow {
            id: 3,
            name: "Burn".to_owned(),
            format_key: "modern".to_owned(),
            format_name: Some("Modern".to_owned()),
            game_key: "paper".to_owned(),
            description: None,
            cover_card_id: Some("bolt-lea".to_owned()),
            cover_kind: "card_art".to_owned(),
            cover_artist: Some("Christopher Rush".to_owned()),
            archived: false,
            card_count: 60,
            updated_at: 1_800_000_000,
            folder_id: Some(7),
            notes: None,
            theory_enabled: true,
            last_variant: "theory".to_owned(),
            last_group_by: "manaValue".to_owned(),
            last_sort_by: "price".to_owned(),
            separate_x_group: true,
            default_category_id: 12,
            bracket: 3,
            // Two keys, both real URLs, because this is the one field on the row whose *shape*
            // crosses the boundary rather than a scalar: `Option<BTreeMap>` has to reach
            // TypeScript as an object of variant keys and not as a list or a bare string, and
            // the deck tile reads `art` out of it by name.
            image_uris: Some(BTreeMap::from([
                (
                    "art".to_owned(),
                    "https://cards.scryfall.io/art/front/0/0/bolt.webp?17".to_owned(),
                ),
                (
                    "display".to_owned(),
                    "https://cards.scryfall.io/display/front/0/0/bolt.webp?17".to_owned(),
                ),
            ])),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "name": "Burn", "formatKey": "modern", "formatName": "Modern",
                "description": null, "coverCardId": "bolt-lea",
                "coverKind": "card_art",
                "coverArtist": "Christopher Rush", "archived": false,
                "cardCount": 60, "updatedAt": 1800000000,
                "folderId": 7, "notes": null, "theoryEnabled": true,
                // The two mode fields carry TypeScript's own vocabulary, so the fixture spells
                // real editor words rather than placeholders: this crate never parses them, and
                // a test written with `"x"` would hide that they are meant to round-trip.
                "lastVariant": "theory", "lastGroupBy": "manaValue", "lastSortBy": "price",
                // `manaValue` above is not an accident either: it is the one grouping the
                // `Split X` chip is drawn under, so this fixture is a deck that would open with
                // the switch on screen and on.
                "separateXGroup": true,
                // A real id rather than `0`, because zero is [`AUTO_CATEGORY`] and would be the
                // answer whether or not the column reached the wire at all.
                "defaultCategoryId": 12,
                // A real platform rather than `"any"`, for the same reason one line up: `any` is
                // the column's default and would read correct on a field that never left Rust.
                "gameKey": "paper",
                // And a real bracket rather than `0`, third application of the same rule:
                // zero is [`AUTO_BRACKET`] and would be the answer whether or not the column
                // reached the wire at all.
                "bracket": 3,
                // The cover printing's picture, spelled out key by key: this is the deck
                // gallery's only way to draw a cover on web and on the phone, and it is a map
                // rather than a URL because `LIST_VARIANTS` decides what a row carries.
                "imageUris": {
                    "art": "https://cards.scryfall.io/art/front/0/0/bolt.webp?17",
                    "display": "https://cards.scryfall.io/display/front/0/0/bolt.webp?17"
                }
            })
        );

        // And the two payloads the frontend sends: `#[serde(default)]` throughout, so a
        // dialog sends the fields it has and a patch sends only what it changed.
        let input: DeckInput = serde_json::from_str(r#"{"name":"Burn","formatKey":"modern"}"#)
            .expect("the create payload");
        assert_eq!(
            (input.name.as_str(), input.format_key.as_str()),
            ("Burn", "modern")
        );
        assert!(input.description.is_none());
        assert!(
            input.theory_enabled.is_none(),
            "an omitted flag is absent, not `false` — `create_deck` decides what absent means"
        );
        assert_eq!(
            input.game_key, "",
            "an omitted game is the empty string, which `valid_game` reads as `any` — a caller \
             written before the field existed makes the deck it always made"
        );

        // The widened create payload in full. These camelCase spellings are the contract
        // `src/lib/ipc.ts` mirrors, and a wrong one here is not a compile error on either side:
        // `#[serde(default)]` would read a misspelled field as an omitted one and the deck would
        // simply come out unconfigured.
        let whole: DeckInput = serde_json::from_str(
            r#"{"name":"Burn","formatKey":"modern","gameKey":"arena","description":"Fast red",
                "notes":"Sideboard plan","coverCardId":"bolt-lea","folderId":7,
                "theoryEnabled":true}"#,
        )
        .expect("the create payload, carrying a whole deck");
        assert_eq!(whole.description.as_deref(), Some("Fast red"));
        assert_eq!(whole.notes.as_deref(), Some("Sideboard plan"));
        assert_eq!(whole.cover_card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(whole.folder_id, Some(7));
        assert_eq!(whole.theory_enabled, Some(true));
        assert_eq!(whole.game_key, "arena");

        let patch: DeckPatch = serde_json::from_str(
            r#"{"coverCardId":"bolt-lea","archived":true,"separateXGroup":true,"gameKey":"mtgo"}"#,
        )
        .expect("the patch payload");
        assert_eq!(patch.cover_card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(patch.archived, Some(true));
        assert_eq!(patch.separate_x_group, Some(true));
        assert_eq!(patch.game_key.as_deref(), Some("mtgo"));
        assert!(patch.name.is_none(), "an omitted field means leave it");

        // And the third: `deck_set_view_state`'s `viewState`, which the editor sends one
        // control at a time — so the omitted two have to arrive as `None` rather than as a
        // deserialization error.
        let view: DeckViewState =
            serde_json::from_str(r#"{"groupBy":"manaValue"}"#).expect("the view-state payload");
        assert_eq!(view.group_by.as_deref(), Some("manaValue"));
        assert!(view.variant.is_none() && view.sort_by.is_none());
    }

    /// Where the reader was looking, as `(variant, group by, sort by)`.
    fn view_state(conn: &Connection, deck_id: i64) -> (String, String, String) {
        conn.query_row(
            "SELECT last_variant, last_group_by, last_sort_by FROM decks WHERE id = ?1",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    /// All three are remembered, and an absent field is left alone — [`update_deck`]'s
    /// `coalesce(?n, column)` convention, so the editor can send the one control the reader
    /// touched instead of the three it has.
    ///
    /// The opening values are asserted first because they are the schema's defaults doing the
    /// job they exist for: a deck that has never been looked at still answers the editor with
    /// the tab and modes it opens on, rather than with three NULLs to guess about.
    #[test]
    fn set_view_state_remembers_each_field_and_leaves_an_absent_one_alone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        assert_eq!(
            view_state(&conn, deck.id),
            (
                "live".to_owned(),
                "category".to_owned(),
                "alphabetical".to_owned()
            )
        );

        set_view_state(
            &conn,
            deck.id,
            &DeckViewState {
                variant: Some(THEORY.to_owned()),
                group_by: Some("manaValue".to_owned()),
                sort_by: Some("price".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(
            view_state(&conn, deck.id),
            (
                "theory".to_owned(),
                "manaValue".to_owned(),
                "price".to_owned()
            )
        );

        // One control moved; the other two are not in the payload and must not move with it.
        set_view_state(
            &conn,
            deck.id,
            &DeckViewState {
                sort_by: Some("type".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            view_state(&conn, deck.id),
            (
                "theory".to_owned(),
                "manaValue".to_owned(),
                "type".to_owned()
            )
        );

        // And the deck row carries them, because the editor reads them off `deck_get`'s row
        // rather than through a command of its own.
        let row = read_deck(&conn, deck.id).unwrap().unwrap();
        assert_eq!(
            (
                row.last_variant.as_str(),
                row.last_group_by.as_str(),
                row.last_sort_by.as_str()
            ),
            ("theory", "manaValue", "type")
        );
    }

    /// **Reading a deck is not editing it**, and this is the whole of that claim: the gallery's
    /// sort key does not move, and the history gains no line.
    ///
    /// It used to make a third claim — that the allocator does not run — which needed the
    /// collection grown *after* the deck was written so that a stray rebuild would have
    /// something new to find. Schema v25 removed the allocator, and with it the only write in
    /// this file that a read could accidentally trigger.
    #[test]
    fn set_view_state_is_not_an_edit() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        conn.execute(
            "UPDATE decks SET updated_at = 0 WHERE id = ?1",
            params![deck.id],
        )
        .unwrap();
        let history_before = count(&conn, "deck_audit");

        set_view_state(
            &conn,
            deck.id,
            &DeckViewState {
                variant: Some(THEORY.to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            updated_at, 0,
            "the gallery sorts on this: opening a tab must not move a deck to the top of it"
        );
        assert_eq!(
            count(&conn, "deck_audit"),
            history_before,
            "the history holds changes to the deck, and which tab was open is not one"
        );
    }

    /// The variant fence, in words. `decks.last_variant` carries **no CHECK** — `ALTER TABLE ADD
    /// COLUMN` cannot add one (schema v12 says so at the column) — so this refusal is the only
    /// thing standing between a typo and a deck that opens on a tab the editor has never heard
    /// of. It is `deck_meta::valid_variant`'s sentence, the same one every card write answers.
    #[test]
    fn set_view_state_refuses_a_variant_the_schema_does_not_know() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = set_view_state(
            &conn,
            deck.id,
            &DeckViewState {
                variant: Some("sideboardish".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();

        assert!(err.contains("sideboardish"), "{err}");
        assert!(err.contains("live, theory"), "{err}");
        assert_eq!(
            view_state(&conn, deck.id).0,
            "live",
            "and the refusal wrote nothing"
        );
    }

    /// The whole of what Rust checks about the two mode fields: they hold a **TypeScript**
    /// vocabulary this crate deliberately does not know (grouping and sorting a deck is domain
    /// logic), so the words are stored verbatim and narrowed on read — but a blank is not one of
    /// them in any vocabulary, and remembering it would hand the editor a choice of nothing.
    #[test]
    fn set_view_state_refuses_a_blank_mode() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        for state in [
            DeckViewState {
                group_by: Some(String::new()),
                ..Default::default()
            },
            DeckViewState {
                sort_by: Some("   ".to_owned()),
                ..Default::default()
            },
        ] {
            assert_eq!(set_view_state(&conn, deck.id, &state).unwrap_err(), NO_MODE);
        }

        // A word this crate has never heard of is *not* refused, and that is the boundary: a
        // mode the editor adds tomorrow needs no migration and no release here.
        set_view_state(
            &conn,
            deck.id,
            &DeckViewState {
                group_by: Some("colourIdentity".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(view_state(&conn, deck.id).1, "colourIdentity");
    }

    /// A stale editor gets the sentence, like every other deck write — never a write that
    /// silently lands nowhere, which is what `UPDATE … WHERE id = ?` is on its own.
    #[test]
    fn set_view_state_on_a_deck_that_is_gone_is_refused_by_name() {
        let conn = seeded();

        assert_eq!(
            set_view_state(&conn, 404, &DeckViewState::default()).unwrap_err(),
            GONE
        );
    }

    /// The X-group switch, end to end: it is off on a new deck, it survives a patch, it leaves
    /// one history row, and a patch that repeats the value it already has records nothing.
    ///
    /// The last of those is [`update_deck`]'s rule rather than this field's, and it is asserted
    /// here because the field is new: a Save on an untouched form must not fill the drawer with
    /// edits nobody made.
    #[test]
    fn the_x_group_switch_round_trips_and_is_recorded_once() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        assert!(
            !deck.separate_x_group,
            "off on a new deck — the column's own DEFAULT 0, never a Rust fallback"
        );

        let on = |v: bool| {
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    separate_x_group: Some(v),
                    ..Default::default()
                },
            )
            .unwrap()
        };

        assert!(on(true).separate_x_group, "and the readback is the write");
        assert!(
            read_deck(&conn, deck.id).unwrap().unwrap().separate_x_group,
            "…including through `DECK_SELECT`'s positional reads, which is where a column \
             added anywhere but the end goes wrong silently"
        );

        // Every other field is untouched by it, which is the `coalesce(?n, column)` contract —
        // and the fence against a mis-numbered `?` hole writing over the neighbour.
        let after = update_deck(&conn, deck.id, &DeckPatch::default()).unwrap();
        assert!(after.separate_x_group, "an absent field means leave it");
        assert_eq!(after.name, "Burn");
        assert!(!after.theory_enabled);

        assert!(!on(false).separate_x_group);

        let words: Vec<serde_json::Value> = crate::deck_audit::list(&conn, deck.id, 10)
            .unwrap()
            .iter()
            .filter(|r| r.kind == crate::deck_audit::DECK)
            .map(|r| serde_json::from_str(&r.payload).unwrap())
            .filter(|p: &serde_json::Value| p["field"] == "xGroup")
            .collect();
        assert_eq!(
            words,
            vec![
                json!({ "field": "xGroup", "from": true, "to": false }),
                json!({ "field": "xGroup", "from": false, "to": true }),
            ],
            "newest first, two presses, and the no-op patch between them recorded nothing"
        );
    }

    /// A copy reads the way its original read. `separate_x_group` is a property of *how the
    /// list is shown*, not of the deck's state, so it travels with the format, the notes and
    /// the theory switch rather than being reset the way `archived` is.
    #[test]
    fn a_duplicate_keeps_the_x_group_switch() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                separate_x_group: Some(true),
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let copy = duplicate_deck(&conn, deck.id).unwrap();
        assert!(copy.separate_x_group, "how it is read comes across");
        assert!(!copy.archived, "what state it is in does not");
    }

    /// The deck's bracket, end to end: a new deck is on Auto, a patch moves it, an absent field
    /// leaves it, and `Some(0)` is a real answer that puts it back rather than a "leave it" the
    /// `coalesce` swallows.
    ///
    /// **That last assertion is the whole reason this column is `NOT NULL` with a sentinel**,
    /// and it is `the_default_category_round_trips_and_zero_really_means_auto`'s argument one
    /// column over: a nullable column would have spelled Auto as `None`, which is exactly what
    /// [`DeckPatch`]'s convention reads as *make no change* — so "back to Auto" would have
    /// needed a command of its own, [`set_folder`]'s price.
    #[test]
    fn the_bracket_round_trips_and_zero_really_means_auto() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Atraxa", "commander")).unwrap();
        assert_eq!(
            deck.bracket, AUTO_BRACKET,
            "a new deck has not been asked — the column's own DEFAULT 0, never a Rust fallback"
        );

        let set = |v: i64| {
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    bracket: Some(v),
                    ..Default::default()
                },
            )
            .unwrap()
        };

        assert_eq!(set(3).bracket, 3, "the readback is the write");
        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().bracket,
            3,
            "…including through `DECK_SELECT`'s positional reads, which is where a column \
             added anywhere but the end goes wrong silently"
        );

        // Every other field is untouched by it, which is the `coalesce(?n, column)` contract —
        // and the fence against a mis-numbered `?` hole writing over the neighbour. The two
        // named here are the ones a mis-numbered hole would actually reach: `?14` is the last
        // in the list, and `default_category_id` and `game_key` are `?12` and `?13`.
        let after = update_deck(&conn, deck.id, &DeckPatch::default()).unwrap();
        assert_eq!(after.bracket, 3, "an absent field means leave it");
        assert_eq!(after.name, "Atraxa");
        assert_eq!(after.default_category_id, AUTO_CATEGORY);
        assert_eq!(after.game_key, DEFAULT_GAME);

        assert_eq!(set(5).bracket, 5, "the top of the range is a real answer");
        assert_eq!(
            set(AUTO_BRACKET).bracket,
            AUTO_BRACKET,
            "and zero is a value, not an absence"
        );
    }

    /// The fence the DDL deliberately does not hold: `decks.bracket` carries no CHECK — not
    /// because `ALTER TABLE … ADD COLUMN` cannot add one, which v19's `deck_cards.finish`
    /// disproves, but because a command parameter reaches it and [`BAD_BRACKET`] can name the
    /// legal answers where `CHECK constraint failed` names only the constraint.
    ///
    /// **Both ends and both edges**, because an off-by-one at either would be invisible to a
    /// test that only tried `6`: `0` and `5` are inside and `-1` and `6` are not, so a
    /// `1..=5` or a `0..=6` fails here rather than in the field.
    ///
    /// **And a refusal writes nothing**, which is the half a "does it return an error" test
    /// misses. [`valid_bracket`] runs before the transaction opens, so a bad number cannot
    /// leave the deck's `updated_at` moved or a history row behind it.
    #[test]
    fn update_deck_refuses_a_bracket_outside_the_five() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Atraxa", "commander")).unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                bracket: Some(2),
                ..Default::default()
            },
        )
        .unwrap();

        for bad in [-1, 6, 99] {
            assert_eq!(
                update_deck(
                    &conn,
                    deck.id,
                    &DeckPatch {
                        bracket: Some(bad),
                        ..Default::default()
                    },
                )
                .unwrap_err(),
                BAD_BRACKET,
                "{bad} is not a bracket, and the refusal is a sentence"
            );
        }
        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().bracket,
            2,
            "a refused patch changed nothing"
        );

        for good in [AUTO_BRACKET, 1, 5] {
            assert_eq!(
                update_deck(
                    &conn,
                    deck.id,
                    &DeckPatch {
                        bracket: Some(good),
                        ..Default::default()
                    },
                )
                .unwrap()
                .bracket,
                good,
                "{good} is a bracket"
            );
        }
    }

    /// One history row per press, worded by the number rather than a name, and none at all for
    /// a patch that re-sends the value the deck already has — [`update_deck`]'s rule, asserted
    /// here because the field is new.
    #[test]
    fn a_bracket_change_is_recorded_once_and_a_repeat_is_not() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Atraxa", "commander")).unwrap();
        let set = |v: i64| {
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    bracket: Some(v),
                    ..Default::default()
                },
            )
            .unwrap();
        };
        set(4);
        set(4); // the no-op
        set(AUTO_BRACKET);

        let words: Vec<serde_json::Value> = crate::deck_audit::list(&conn, deck.id, 10)
            .unwrap()
            .iter()
            .filter(|r| r.kind == crate::deck_audit::DECK)
            .map(|r| serde_json::from_str(&r.payload).unwrap())
            .filter(|p: &serde_json::Value| p["field"] == "bracket")
            .collect();
        assert_eq!(
            words,
            vec![
                json!({ "field": "bracket", "from": 4, "to": 0 }),
                json!({ "field": "bracket", "from": 0, "to": 4 }),
            ],
            "newest first, two presses, and the repeat between them recorded nothing"
        );
    }

    /// A copy is the same deck's bracket. It is an answer *about the deck*, the way
    /// `separate_x_group` is — not a note about how the reader was looking at it a moment ago —
    /// so it travels where `archived` is reset.
    #[test]
    fn a_duplicate_keeps_the_bracket() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Atraxa", "commander")).unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                bracket: Some(4),
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let copy = duplicate_deck(&conn, deck.id).unwrap();
        assert_eq!(copy.bracket, 4, "what the deck *is* comes across");
        assert!(!copy.archived, "what state it is in does not");
    }

    /// The deck's default pile, end to end: a new deck is on Auto, a patch moves it, an absent
    /// field leaves it, and `Some(0)` is a real answer that puts it back rather than a "leave
    /// it" the `coalesce` swallows.
    ///
    /// **That last assertion is the whole reason this column is `NOT NULL` with a sentinel.** A
    /// nullable one would have spelled Auto as `None`, which is exactly what [`DeckPatch`]'s
    /// convention reads as *make no change* — so "back to Auto" would have needed a command of
    /// its own, `set_folder`'s price. Zero costs nothing and cannot collide: rowids start at 1.
    #[test]
    fn the_default_category_round_trips_and_zero_really_means_auto() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        assert_eq!(
            deck.default_category_id, AUTO_CATEGORY,
            "a new deck files by what the card does — the column's own DEFAULT 0"
        );

        let set = |v: i64| {
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    default_category_id: Some(v),
                    ..Default::default()
                },
            )
            .unwrap()
        };

        assert_eq!(
            set(main).default_category_id,
            main,
            "the readback is the write"
        );
        assert_eq!(
            read_deck(&conn, deck.id)
                .unwrap()
                .unwrap()
                .default_category_id,
            main,
            "…including through `DECK_SELECT`'s positional reads, which is where a column \
             added anywhere but the end goes wrong silently"
        );

        let after = update_deck(&conn, deck.id, &DeckPatch::default()).unwrap();
        assert_eq!(
            after.default_category_id, main,
            "an absent field means leave it"
        );
        assert_eq!(after.name, "Burn", "and touches no neighbour");

        assert_eq!(
            set(AUTO_CATEGORY).default_category_id,
            AUTO_CATEGORY,
            "zero is a value, not an absence"
        );
    }

    /// The fence the DDL cannot hold: no foreign key names this column, so "a deck's default
    /// pile is a pile of *that* deck" lives in [`category_of_deck`] — the same two sentences
    /// every card write answers, because "gone" and "not yours" are different things to tell a
    /// stale editor.
    #[test]
    fn the_default_category_must_be_a_pile_of_this_deck() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let other = create_deck(&conn, &input("Elves", "modern")).unwrap();
        let theirs = main_of(&conn, other.id);

        let refuse = |v: i64| {
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    default_category_id: Some(v),
                    ..Default::default()
                },
            )
            .unwrap_err()
        };

        assert_eq!(refuse(theirs), crate::deck_meta::CATEGORY_WRONG_DECK);
        assert_eq!(refuse(404_040), crate::deck_meta::CATEGORY_GONE);
        assert_eq!(
            read_deck(&conn, deck.id)
                .unwrap()
                .unwrap()
                .default_category_id,
            AUTO_CATEGORY,
            "and neither refusal wrote anything"
        );
    }

    /// The history says the pile's **name**, and Auto is `null` on both sides.
    ///
    /// A bare category id in a `to` is a number no reader can resolve once the pile has been
    /// renamed or deleted, and this drawer is read months later — `record_filed`'s reasoning for
    /// resolving a folder to its path, applied to the one other column that points at a row with
    /// a name of its own.
    #[test]
    fn the_default_category_history_names_the_pile() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let main_name: String = conn
            .query_row(
                "SELECT name FROM deck_categories WHERE id = ?1",
                params![main],
                |r| r.get(0),
            )
            .unwrap();

        for v in [main, main, AUTO_CATEGORY] {
            update_deck(
                &conn,
                deck.id,
                &DeckPatch {
                    default_category_id: Some(v),
                    ..Default::default()
                },
            )
            .unwrap();
        }

        let words: Vec<serde_json::Value> = crate::deck_audit::list(&conn, deck.id, 10)
            .unwrap()
            .iter()
            .filter(|r| r.kind == crate::deck_audit::DECK)
            .map(|r| serde_json::from_str(&r.payload).unwrap())
            .filter(|p: &serde_json::Value| p["field"] == "defaultCategory")
            .collect();
        assert_eq!(
            words,
            vec![
                json!({ "field": "defaultCategory", "from": main_name, "to": null }),
                json!({ "field": "defaultCategory", "from": null, "to": main_name }),
            ],
            "newest first, two moves, and the patch repeating the value recorded nothing"
        );
    }

    /// Deleting the pile a deck files by puts that deck back on Auto — the clean-up an
    /// `ON DELETE SET NULL` would do for free on a nullable column, and one of the two sites
    /// that pay for the sentinel.
    ///
    /// **The cost of leaving it undone is not cosmetic**: `deck_cards.category_id` carries a real
    /// foreign key, so the next unfiled add would be written at an id with no pile behind it and
    /// refused — on a deck whose settings still read the deleted name.
    #[test]
    fn deleting_the_default_pile_puts_the_deck_back_on_auto() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let pile = crate::deck_meta::create_category(&conn, deck.id, "Removal")
            .unwrap()
            .id;
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                default_category_id: Some(pile),
                ..Default::default()
            },
        )
        .unwrap();

        crate::deck_meta::delete_category(&conn, pile, None).unwrap();

        assert_eq!(
            read_deck(&conn, deck.id)
                .unwrap()
                .unwrap()
                .default_category_id,
            AUTO_CATEGORY
        );
    }

    /// A copy files where its original filed — into **its own** pile of that name, never the
    /// original's row. The number is a `deck_categories.id`, and the copy's categories are new
    /// rows, so this is `deck_cards`' remap applied to the one `decks` column that needs it.
    ///
    /// Getting it wrong is quiet: nothing breaks, and every add made in the duplicate lands in a
    /// column of a deck the reader is not looking at.
    #[test]
    fn a_duplicate_files_into_its_own_copy_of_the_default_pile() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let pile = crate::deck_meta::create_category(&conn, deck.id, "Removal")
            .unwrap()
            .id;
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                default_category_id: Some(pile),
                ..Default::default()
            },
        )
        .unwrap();

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        assert_ne!(
            copy.default_category_id, pile,
            "never the original's row — that is the failure the id maps exist to prevent"
        );
        let (owner, name): (i64, String) = conn
            .query_row(
                "SELECT deck_id, name FROM deck_categories WHERE id = ?1",
                params![copy.default_category_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((owner, name.as_str()), (copy.id, "Removal"));

        // And a source on Auto stays on Auto, because zero is in no map.
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                default_category_id: Some(AUTO_CATEGORY),
                ..Default::default()
            },
        )
        .unwrap();
        let plain = duplicate_deck(&conn, deck.id).unwrap();
        assert_eq!(plain.default_category_id, AUTO_CATEGORY);
    }

    /// **A Bolt is a Bolt.** The deck lists the Alpha printing and its own group holds the M10
    /// one, and it still reads owned: matching by **oracle id** is what the allocator did
    /// across printings, and keeping it is why a reader who let the allocator choose sees the
    /// same answer after v25 as before it.
    #[test]
    fn a_deck_owns_what_its_own_group_holds_across_printings() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 1);
        file_into_group(&conn, deck.id, "bolt-m10", 1);

        let owned = owned_by_oracle(&conn, deck.id).unwrap();

        assert_eq!(owned.get("o1"), Some(&1));
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", main),
            1,
            "and the editor reads it through the same map"
        );
    }

    /// Custody, not a claim: a copy sitting in **another** deck's group is that deck's, and no
    /// arithmetic anywhere lets this one count it. The old ledger could overlap two decks on
    /// one row; a placement cannot, which is the whole of what changed at v25.
    #[test]
    fn another_decks_group_is_not_this_decks_owned() {
        let conn = seeded();
        let a = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let b = create_deck(&conn, &input("Storm", "modern")).unwrap();
        add(&conn, a.id, "bolt-lea", main_of(&conn, a.id), 1);
        file_into_group(&conn, b.id, "bolt-lea", 1);

        assert!(owned_by_oracle(&conn, a.id).unwrap().is_empty());
    }

    /// **The copies in the group are the deck's, and the binder is not decremented to say so** —
    /// because there is nothing left to decrement. The rows *are* in the deck: they carry its
    /// folder id and the collection's own reads exclude them, which is the whole of spec §6's
    /// non-destructive model restated as custody. Two entries of two printings of one oracle
    /// card, and the read sums both.
    #[test]
    fn a_deck_reads_owned_from_every_row_in_its_group() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        let lea = file_into_group(&conn, deck.id, "bolt-lea", 2);
        let m10 = file_into_group(&conn, deck.id, "bolt-m10", 1);

        let detail = get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap();
        let row = card_row(&detail, "bolt-lea", main);
        assert_eq!((row.quantity, row.owned_quantity), (4, 3), "3 of 4");

        let held: Vec<(i64, i64)> = conn
            .prepare("SELECT id, quantity FROM collection_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            held,
            vec![(lea, 2), (m10, 1)],
            "and the rows are untouched — filing a card is not spending it"
        );
    }

    /// **Rule 1, and the whole of what the `maybe` zone used to be.** `is_active` is the only
    /// thing this asks: a category of the user's own that they switch off stops being handed
    /// the copies the deck holds, and a Maybeboard they switch **on** starts. Nothing anywhere
    /// reads the word `maybe` to decide it.
    ///
    /// The two halves matter equally. The first is the bug a leftover `zone <> 'maybe'` would
    /// hide — it would look correct until the day a user deactivated a category of their own.
    /// The second is the bug the *fix* could introduce: excluding the `maybe` **kind** as
    /// well as inactive categories would be a special case nobody could switch off.
    #[test]
    fn an_inactive_category_is_handed_nothing_and_a_named_one_is() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let mine = crate::deck_meta::create_category(&conn, deck.id, "Flex slots").unwrap();
        let scratch = kind_of(&conn, deck.id, "maybe");
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        add(&conn, deck.id, "bolt-lea", mine.id, 2);
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", mine.id),
            2,
            "a category the user made is active, so it is served"
        );

        crate::deck_meta::set_category_active(&conn, mine.id, false).unwrap();
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", mine.id),
            0,
            "switched off, it is served nothing — and no kind check could have known that"
        );

        // The other direction: the Maybeboard is only special because it is seeded off.
        crate::deck_meta::set_category_active(&conn, scratch, true).unwrap();
        add(&conn, deck.id, "bolt-lea", scratch, 1);
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", scratch),
            1,
            "a Maybeboard the user switched ON is served like any other category"
        );
    }

    /// **Rule 2.** A theory list is a plan, and a plan holds nothing: the copies in the deck's
    /// group belong to what is sleeved up, and the plan beside it must say so rather than
    /// borrowing the answer.
    #[test]
    fn the_allocator_claims_nothing_for_the_theory_variant() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(main),
            None,
            THEORY,
            None,
            4,
        )
        .unwrap();

        let theory = get_deck(&conn, deck.id, THEORY, ANY_MARKET)
            .unwrap()
            .unwrap();
        assert_eq!(
            card_row(&theory, "bolt-lea", main).owned_quantity,
            0,
            "a plan holds nothing, even while the group holds a playset"
        );

        // The same printing, the same category, in the live deck: that one is served — and the
        // theory row beside it *still* reads 0. This is the half a naive read gets wrong: a
        // group is not scoped to a variant, so a theory read walks the very copies the sleeved
        // deck is holding and would hand the plan all four of them.
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", main), 4);
        let theory = get_deck(&conn, deck.id, THEORY, ANY_MARKET)
            .unwrap()
            .unwrap();
        assert_eq!(
            card_row(&theory, "bolt-lea", main).owned_quantity,
            0,
            "a plan holds nothing even when the deck it is a plan for holds everything"
        );
    }

    /// **The read follows the group's row, because there is nothing else it could follow.**
    /// Until schema v25 this test was about a *clamp*: a claim of 4 against an entry the reader
    /// had since stepped to 1 read 1, because a claim could out-live the row it was made
    /// against. Custody cannot, so the number is simply read — and the two halves that mattered
    /// still do: a row stepped down says so, and a row taken to zero is **deleted** (v24's
    /// rule) and holds nothing at all.
    #[test]
    fn owned_quantity_follows_the_group_row_down_to_zero() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        let entry = file_into_group(&conn, deck.id, "bolt-lea", 4);
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", main), 4);

        crate::collection::set_quantity(&conn, entry, 1).unwrap();
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", main),
            1,
            "a shrunken row is a shrunken deck, with no write to the deck at all"
        );

        crate::collection::set_quantity(&conn, entry, 0).unwrap();
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", main), 0);
        assert_eq!(
            count(&conn, "collection_entries"),
            0,
            "and the row went with the copies"
        );
    }

    /// TRAP B and TRAP C ride the read: two printings of one card with different `oldschool`
    /// legalities come back with their own blobs; a rare printing whose oracle card was ever
    /// printed at uncommon reads `ever_uncommon = true`.
    #[test]
    fn the_read_returns_per_printing_legalities_and_ever_uncommon() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Angels", "oldschool")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "serra-lea", main, 1);
        add(&conn, deck.id, "serra-8ed", side, 1);
        add(&conn, deck.id, "bolt-lea", main, 4);

        let detail = get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap();
        let alpha = card_row(&detail, "serra-lea", main);
        let eighth = card_row(&detail, "serra-8ed", side);

        assert!(
            alpha.legalities.as_deref().unwrap().contains("\"legal\""),
            "{:?}",
            alpha.legalities
        );
        assert!(
            eighth
                .legalities
                .as_deref()
                .unwrap()
                .contains("\"oldschool\":\"not_legal\""),
            "the printing's own blob, which is the whole of Old School: {:?}",
            eighth.legalities
        );
        assert_eq!(
            (alpha.rarity.as_deref(), eighth.rarity.as_deref()),
            (Some("uncommon"), Some("rare"))
        );
        assert!(
            alpha.ever_uncommon && eighth.ever_uncommon,
            "a RARE printing of a card that was uncommon somewhere is a PDH commander — \
             eligibility is computed over the oracle card, never read off this printing"
        );
        assert!(
            !card_row(&detail, "bolt-lea", main).ever_uncommon,
            "and a card that never was uncommon is not"
        );

        // The facts the engine reads beside them, from this printing's row.
        assert_eq!(
            (
                alpha.cmc,
                alpha.color_identity.as_deref(),
                alpha.type_line.as_deref(),
                alpha.power.as_deref(),
                alpha.unit_price
            ),
            (
                Some(5.0),
                Some("W"),
                Some("Creature — Angel"),
                Some("4"),
                Some(120.0)
            )
        );
        assert_eq!(
            card_row(&detail, "bolt-lea", main).unit_price,
            Some(400.0),
            "nonfoil `usd` out of the blob, never `price_usd`"
        );
    }

    /// A deck row's one price comes from the marketplace the read was given, and from nowhere
    /// else — no cross-marketplace fallback, at any finish. The etched-only printing is what
    /// separates the four: two of them quote it and two do not, and neither pair borrows the
    /// other's number.
    #[test]
    fn a_deck_row_is_priced_by_the_marketplace_the_read_was_given() {
        let conn = seeded();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,price_usd,price_eur,raw)
               VALUES
                 ('both','o3','Both','tst','1','en','normal',
                  '{"usd":"10.00","eur":"7.50"}',10.0,7.5,'{}'),
                 ('etched-only','o4','Etched Only','tst','2','en','normal',
                  '{"usd":null,"usd_foil":null,"usd_etched":"0.71","eur":null,"eur_foil":null}',
                  0.71,NULL,'{}');"#,
        )
        .unwrap();
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "both", "nonfoil", 9.00),
                // Card Kingdom has never listed `bolt-lea`, and the etched printing has only an
                // etched row — the last link of the chain, and the only one it can be sold in.
                ("cardkingdom", "etched-only", "etched", 0.60),
                ("manapool", "both", "nonfoil", 11.00),
                ("manapool", "bolt-lea", "nonfoil", 390.00),
            ],
        );
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "both", main, 1);
        add(&conn, deck.id, "etched-only", main, 1);
        add(&conn, deck.id, "bolt-lea", main, 1);

        let price = |card: &str, marketplace| {
            let detail = get_deck(&conn, deck.id, LIVE, marketplace)
                .unwrap()
                .unwrap();
            card_row(&detail, card, main).unit_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(price("both", Tcgplayer), Some(10.0));
        assert_eq!(price("both", Cardmarket), Some(7.5));
        assert_eq!(price("both", Cardkingdom), Some(9.0));
        assert_eq!(price("both", Manapool), Some(11.0));

        assert_eq!(
            price("etched-only", Tcgplayer),
            Some(0.71),
            "the printing is sold in one finish and TCGplayer quotes it"
        );
        assert_eq!(
            price("etched-only", Cardkingdom),
            Some(0.60),
            "the feed's own etched row, not the blob's figure"
        );
        for marketplace in [Cardmarket, Manapool] {
            assert_eq!(
                price("etched-only", marketplace),
                None,
                "{marketplace:?} does not quote this printing in any finish it is sold in — \
                 Cardmarket because `eur_etched` is a key Scryfall does not have, Mana Pool \
                 because it has never listed it — and neither borrows the other's 0.71"
            );
        }

        assert_eq!(
            price("bolt-lea", Cardmarket),
            None,
            "a blob with no `eur` at all is unpriced, never the dollar figure"
        );
        assert_eq!(
            price("bolt-lea", Cardkingdom),
            None,
            "and a printing the feed has never listed is unpriced too"
        );
        assert_eq!(price("bolt-lea", Manapool), Some(390.0));
    }

    /// `'nonfoil'` is not a value this column stores, and [`normalise_finish`] is where that
    /// becomes true rather than merely intended.
    #[test]
    fn nonfoil_normalises_to_the_regular_row() {
        assert_eq!(normalise_finish(None).unwrap(), None);
        assert_eq!(
            normalise_finish(Some("nonfoil")).unwrap(),
            None,
            "the word and the absence are one thing, or the grain holds two rows that draw alike"
        );
        assert_eq!(
            normalise_finish(Some("foil")).unwrap(),
            Some("foil".to_owned())
        );
        assert_eq!(
            normalise_finish(Some("etched")).unwrap(),
            Some("etched".to_owned())
        );
        assert!(
            normalise_finish(Some("holo")).is_err(),
            "a finish this app has never heard of is refused, never quietly filed as regular"
        );
    }

    /// A pile holds the foil copy **beside** the regular one, and each folds on its own.
    ///
    /// The whole feature in one assertion: `1 × foil` next to `3 × regular` of one printing, in
    /// one pile, as two rows.
    #[test]
    fn a_pile_holds_the_foil_copy_beside_the_regular_one() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-m10", main, 2);
        add(&conn, deck.id, "bolt-m10", main, 1);
        add_foil(&conn, deck.id, "bolt-m10", main, 1);

        let rows = live_rows(&conn, deck.id);
        assert_eq!(
            rows,
            vec![(None, 3), (Some("foil".to_owned()), 1)],
            "the two regular adds folded together and the foil add did not join them"
        );
    }

    /// Setting a finish onto a row the pile already has **folds**, exactly as a swap onto a
    /// printing the pile already holds does — and the surviving row is the one that was there.
    #[test]
    fn setting_a_finish_folds_into_the_row_that_is_already_there() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-m10", main, 3);
        add_foil(&conn, deck.id, "bolt-m10", main, 1);

        let result =
            set_card_finish(&conn, deck.id, "bolt-m10", main, LIVE, Some("foil"), None).unwrap();
        assert!(result.folded, "the pile already held a regular row");
        assert_eq!(result.quantity, 4, "the sum, not the copies that moved");
        assert_eq!(
            live_rows(&conn, deck.id),
            vec![(None, 4)],
            "one row of four, and no foil row left behind"
        );
    }

    /// With nothing to fold into, the row changes finish **in place** and keeps its quantity.
    #[test]
    fn setting_a_finish_with_no_row_to_fold_into_moves_the_row() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-m10", main, 2);

        let result =
            set_card_finish(&conn, deck.id, "bolt-m10", main, LIVE, None, Some("foil")).unwrap();
        assert!(!result.folded);
        assert_eq!(result.quantity, 2);
        assert_eq!(
            live_rows(&conn, deck.id),
            vec![(Some("foil".to_owned()), 2)]
        );
    }

    /// Three refusals, each its own sentence, and none of them a panic.
    #[test]
    fn set_card_finish_refuses_the_three_things_it_cannot_do() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-m10", main, 1);
        add(&conn, deck.id, "bolt-lea", main, 1);

        assert_eq!(
            set_card_finish(
                &conn,
                deck.id,
                "bolt-m10",
                main,
                LIVE,
                None,
                Some("nonfoil")
            )
            .unwrap_err(),
            SAME_FINISH,
            "`nonfoil` and absent are the same finish, so this changes nothing and writes nothing"
        );
        // Alpha printed no foils, and this fixture's `cards.finishes` says so.
        assert_eq!(
            set_card_finish(&conn, deck.id, "bolt-lea", main, LIVE, None, Some("foil"))
                .unwrap_err(),
            FINISH_NOT_SOLD
        );
        assert!(
            set_card_finish(&conn, deck.id, "bolt-m10", main, LIVE, Some("etched"), None).is_err(),
            "there is no etched row in that pile to change"
        );
    }

    /// A stepper aimed at one finish must not find the other — the grain is five columns wide,
    /// and every card command's `WHERE` has to agree with it.
    #[test]
    fn a_write_aimed_at_one_finish_leaves_the_other_row_alone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-m10", main, 3);
        add_foil(&conn, deck.id, "bolt-m10", main, 2);

        set_card_quantity(&conn, deck.id, "bolt-m10", main, LIVE, Some("foil"), 0).unwrap();
        assert_eq!(
            live_rows(&conn, deck.id),
            vec![(None, 3)],
            "the foil row went and the regular one is untouched"
        );
    }

    /// A duplicate of a deck of foils is a deck of foils. The copy has the same shape as its
    /// original — `deck_categories.origin`'s rule, one table over.
    #[test]
    fn a_duplicate_keeps_the_finishes_of_the_deck_it_copies() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add_foil(&conn, deck.id, "bolt-m10", main, 2);

        let copy = duplicate_deck(&conn, deck.id).unwrap();
        assert_eq!(
            live_rows(&conn, copy.id),
            vec![(Some("foil".to_owned()), 2)]
        );
    }

    /// **A deck row carries the printing's `promo_types`, from the end of a 36-column
    /// positional read.**
    ///
    /// Issue #160: `finishes` says how shiny the object can be and `finish` which copy this
    /// deck sleeves, and neither can say *which* shiny. The naming is TypeScript's
    /// (`src/lib/treatment.ts`); this is the column reaching it.
    ///
    /// The column went in **after `dc.finish`**, which is [`deck_row`]'s stated rule and not a
    /// preference: this read is positional, and `promo_types` reads like it belongs beside
    /// `c.finishes` at 30 — where it would have handed a printing's finishes to its treatments
    /// and a set name to its finishes, both still plausible strings with nothing going red. So
    /// the three fields that sit between the two candidate positions are asserted alongside it,
    /// and `unit_price` is the one that cannot be got right by accident: this printing is sold
    /// in both finishes at **different** prices, so a shifted index is a wrong number rather
    /// than a null.
    #[test]
    fn a_deck_row_carries_the_printings_promo_types() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET promo_types = '[\"surgefoil\"]' WHERE id = 'bolt-m10'",
            [],
        )
        .unwrap();
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add_foil(&conn, deck.id, "bolt-m10", main, 2);
        add(&conn, deck.id, "bolt-lea", main, 1);

        let cards = read_deck_cards(&conn, deck.id, LIVE, ANY_MARKET).unwrap();
        let treated = cards.iter().find(|c| c.card_id == "bolt-m10").unwrap();
        assert_eq!(treated.promo_types.as_deref(), Some(r#"["surgefoil"]"#));
        assert_eq!(treated.finish.as_deref(), Some("foil"));
        assert_eq!(treated.finishes.as_deref(), Some(r#"["nonfoil","foil"]"#));
        assert_eq!(
            treated.unit_price,
            Some(6.00),
            "the foil rate, not the chain"
        );
        assert!(!treated.ever_uncommon);

        // A printing with no treatment answers `None`, not an empty array — four fifths of the
        // corpus is NULL here and that is the shape every reader fences on.
        let plain = cards.iter().find(|c| c.card_id == "bolt-lea").unwrap();
        assert_eq!(plain.promo_types, None);
        assert_eq!(plain.finish, None);
    }

    /// Every `live` row of a deck as `(finish, quantity)`, ordered so a regular row sorts before
    /// a foil one. The shape almost every test in this group asserts on.
    fn live_rows(conn: &Connection, deck_id: i64) -> Vec<(Option<String>, i64)> {
        conn.prepare(
            "SELECT finish, quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = 'live'
              ORDER BY coalesce(finish, '')",
        )
        .unwrap()
        .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    }

    /// **A row that names a finish is priced at that finish, and one that names none keeps the
    /// chain** — the two arms of [`crate::sorting::deck_card_price_expr`], driven through real
    /// SQL rather than asserted about its text.
    ///
    /// The text-level test in `sorting.rs` checks that the expression is assembled out of the
    /// right two pieces; this one checks that the assembled thing *runs* and answers, which is
    /// the half a `contains()` cannot see.
    ///
    /// The printing is deliberately sold in **both** finishes at **different** prices, so a
    /// wrong arm is a wrong number rather than a null — an em dash would also be produced by
    /// the expression failing to find anything at all, and the two must not be confusable.
    #[test]
    fn a_deck_row_is_priced_at_the_finish_it_names_and_chained_when_it_names_none() {
        let conn = seeded();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    finishes,prices,raw)
               VALUES ('both','o7','Both Ways','tst','3','en','normal','["nonfoil","foil"]',
                  '{"usd":"1.00","usd_foil":"9.00","usd_etched":null,
                    "eur":"0.90","eur_foil":"8.10"}','{}');"#,
        )
        .unwrap();
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "both", "nonfoil", 1.10),
                ("cardkingdom", "both", "foil", 9.90),
            ],
        );
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "both", main, 1);

        let price = |marketplace| {
            get_deck(&conn, deck.id, LIVE, marketplace)
                .unwrap()
                .unwrap()
                .cards
                .iter()
                .find(|c| c.card_id == "both")
                .unwrap()
                .unit_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Tcgplayer};

        // Says nothing: the chain, whose first link is the nonfoil rate.
        assert_eq!(price(Tcgplayer), Some(1.00));
        assert_eq!(price(Cardmarket), Some(0.90));
        assert_eq!(price(Cardkingdom), Some(1.10));

        conn.execute("UPDATE deck_cards SET finish = 'foil'", [])
            .unwrap();

        // Says foil: the foil rate, on every marketplace, out of that marketplace's own source
        // — the blob for two of them and `marketplace_prices` for the feed.
        assert_eq!(price(Tcgplayer), Some(9.00));
        assert_eq!(price(Cardmarket), Some(8.10));
        assert_eq!(price(Cardkingdom), Some(9.90));

        // Says etched, on a printing sold in no such thing: **unpriced, never the nonfoil
        // rate**. The reader has named an object this printing is not, and quoting the plain
        // copy's price for it would be a number nobody published — the same rule the euro
        // etched hole is kept by one module over.
        conn.execute("UPDATE deck_cards SET finish = 'etched'", [])
            .unwrap();
        assert_eq!(price(Tcgplayer), None);
        assert_eq!(price(Cardmarket), None);
        assert_eq!(price(Cardkingdom), None);
    }

    /// **A printing sold only in foil is priced at its foil rate, and this is the bug that made
    /// the rule.**
    ///
    /// A deck row was priced at the literal `'nonfoil'`, on the reasoning that a deck names a
    /// printing and not a finish — but the corpus has **13 515 foil-only and 892 etched-only
    /// printings, and not one of them has a nonfoil price at any marketplace** (measured against
    /// a synced database on 2026-08-15). So the finish a deck row does not name was answered
    /// with a price that does not exist, and a Secret Lair or a promo drew an em dash on the
    /// card's foot while the search panel beside it quoted the same printing.
    ///
    /// The chain is [`crate::sorting::printing_price_by_finish_expr`]'s, so the euro hole is
    /// still the euro hole: `eur_etched` is a key Scryfall does not have, and an etched-only
    /// printing stays unpriced on Cardmarket rather than being quoted at a rate nobody published.
    #[test]
    fn a_foil_only_printing_is_priced_at_the_finish_it_is_sold_in() {
        let conn = seeded();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    finishes,prices,raw)
               VALUES
                 ('foil-only','o5','Foil Only','sld','780','en','normal','["foil"]',
                  '{"usd":null,"usd_foil":"3.48","usd_etched":null,
                    "eur":null,"eur_foil":"2.90"}','{}'),
                 ('etched-only','o6','Etched Only','tst','2','en','normal','["etched"]',
                  '{"usd":null,"usd_foil":null,"usd_etched":"0.71",
                    "eur":null,"eur_foil":null}','{}');"#,
        )
        .unwrap();
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "foil-only", "foil", 3.83),
                ("cardkingdom", "etched-only", "etched", 0.60),
                ("manapool", "foil-only", "foil", 3.20),
            ],
        );
        let deck = create_deck(&conn, &input("Bling", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "foil-only", main, 1);
        add(&conn, deck.id, "etched-only", main, 1);
        add(&conn, deck.id, "bolt-lea", main, 1);

        let price = |card: &str, marketplace| {
            card_row(
                &get_deck(&conn, deck.id, LIVE, marketplace)
                    .unwrap()
                    .unwrap(),
                card,
                main,
            )
            .unit_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(price("foil-only", Tcgplayer), Some(3.48));
        assert_eq!(price("foil-only", Cardmarket), Some(2.90));
        assert_eq!(price("foil-only", Cardkingdom), Some(3.83));
        assert_eq!(price("foil-only", Manapool), Some(3.20));

        assert_eq!(price("etched-only", Tcgplayer), Some(0.71));
        assert_eq!(price("etched-only", Cardkingdom), Some(0.60));
        assert_eq!(
            price("etched-only", Cardmarket),
            None,
            "there is no `eur_etched` key in Scryfall's data, and a chain must not reach past a \
             hole into the nonfoil rate"
        );
        assert_eq!(
            price("etched-only", Manapool),
            None,
            "a printing this feed has never listed is unpriced, in any finish"
        );

        assert_eq!(
            price("bolt-lea", Tcgplayer),
            Some(400.0),
            "a printing quoted nonfoil is still quoted nonfoil — the chain starts there"
        );
    }

    /// Rows in `marketplace_prices` — [`crate::collection`]'s helper, kept per module.
    fn seed_feed(conn: &Connection, rows: &[(&str, &str, &str, f64)]) {
        for (marketplace, card_id, finish, price) in rows {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_prices
                    (marketplace, card_id, finish, price) VALUES (?1,?2,?3,?4)",
                params![marketplace, card_id, finish, price],
            )
            .unwrap();
        }
    }

    /// **Rules 4 and 6.** One read answers with one variant's cards and **every** category and
    /// label the deck owns — an empty category still draws its column, an inactive one always
    /// draws, and a label nobody is wearing is still in the palette. The cards come back in
    /// category `sort_order`, then the row's own name, then row id.
    #[test]
    fn the_read_scopes_cards_by_variant_and_answers_with_every_category_and_label() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        let scratch = kind_of(&conn, deck.id, "maybe");
        let label = crate::deck_meta::create_label(&conn, deck.id, "Flex", "amber").unwrap();
        crate::deck_meta::create_label(&conn, deck.id, "Unworn", "slate").unwrap();
        // Written so the reading order is neither the insert order nor the category order a
        // reader would guess: the Sideboard and the Maybeboard both sort *before* the main
        // pile, because they were seeded with the deck and the main pile was made by the
        // first add. Inside it the Bolt sorts before the Angel on the row's own name, which
        // is the reverse of the order they were written in.
        add(&conn, deck.id, "serra-lea", main, 1);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-m10", side, 2);
        add(&conn, deck.id, "bolt-jp", scratch, 3);
        add_card(
            &conn,
            deck.id,
            "serra-8ed",
            Some(main),
            None,
            THEORY,
            None,
            7,
        )
        .unwrap();
        crate::deck_meta::set_card_label(
            &conn,
            deck.id,
            "bolt-lea",
            main,
            LIVE,
            None,
            Some(label.id),
        )
        .unwrap();
        crate::deck_meta::set_card_label(
            &conn,
            deck.id,
            "serra-8ed",
            main,
            THEORY,
            None,
            Some(label.id),
        )
        .unwrap();

        let live = get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap();

        assert_eq!(
            live.cards
                .iter()
                .map(|c| (c.card_id.as_str(), c.category_name.as_str(), c.quantity))
                .collect::<Vec<_>>(),
            vec![
                ("bolt-m10", "Sideboard", 2),
                ("bolt-jp", "Maybeboard", 3),
                ("bolt-lea", "Main deck", 4),
                ("serra-lea", "Main deck", 1),
            ],
            "category `sort_order` first, then the name the row carries"
        );
        assert!(
            live.cards.iter().all(|c| c.variant == LIVE),
            "one variant's cards, and only that one's"
        );
        let bolt = card_row(&live, "bolt-lea", main);
        assert_eq!(
            (
                bolt.category_kind.as_str(),
                bolt.category_active,
                bolt.label_name.as_deref(),
                bolt.label_color.as_deref()
            ),
            ("main", true, Some("Flex"), Some("amber")),
            "the kind the rules read, the flag that decides whether they read it at all, and \
             the label the row is wearing"
        );
        assert!(
            !card_row(&live, "bolt-jp", scratch).category_active,
            "the Maybeboard is seeded off, which is the whole of what makes it a scratchpad"
        );
        assert!(card_row(&live, "bolt-m10", side).label_id.is_none());

        assert_eq!(
            live.categories
                .iter()
                .map(|c| (c.name.as_str(), c.card_count))
                .collect::<Vec<_>>(),
            vec![
                ("Commander", 0),
                ("Sideboard", 2),
                ("Companion", 0),
                ("Maybeboard", 3),
                ("Main deck", 5),
            ],
            "every category in `sort_order`, empty ones included — that is where the next \
             card goes"
        );
        assert_eq!(
            live.labels
                .iter()
                .map(|t| (t.name.as_str(), t.card_count))
                .collect::<Vec<_>>(),
            vec![("Flex", 4)],
            "and every label **this list wears**, `Unworn` being a label of the app rather than \
             of a deck since v21 — `card_count` being copies rather than rows, which \
             is why the label on one four-of reads 4"
        );

        let theory = get_deck(&conn, deck.id, THEORY, ANY_MARKET)
            .unwrap()
            .unwrap();
        assert_eq!(
            theory
                .cards
                .iter()
                .map(|c| (c.card_id.as_str(), c.quantity))
                .collect::<Vec<_>>(),
            vec![("serra-8ed", 7)],
            "the other list is its own list"
        );
        assert_eq!(
            theory.categories.len(),
            live.categories.len(),
            "and it draws exactly the same columns"
        );
        assert_eq!(
            theory
                .categories
                .iter()
                .find(|c| c.id == main)
                .unwrap()
                .card_count,
            7,
            "with the counts of the variant that was asked for"
        );
        // **And the labels are counted over that same variant**, which they briefly were not:
        // `get_deck` threaded its variant into the category list and not into the label list, so
        // a Theory read came back with Theory category counts beside Live label counts. Live has
        // 4 labelled copies and Theory has 7, so a leak reads 4 here — a number belonging to a
        // list this answer is not about.
        assert_eq!(
            theory
                .labels
                .iter()
                .map(|t| (t.name.as_str(), t.card_count))
                .collect::<Vec<_>>(),
            vec![("Flex", 7)],
            "one read, one list of cards, one variant — on all three of its parts"
        );
    }

    /// An orphaned deck card is still a row: name/set/cn from the entry, card facts NULL,
    /// owned 0 — listed, never dropped (the LEFT JOIN discipline).
    #[test]
    fn an_orphaned_deck_card_is_listed_from_its_denormalized_columns() {
        let conn = seeded();
        own(&conn, "bolt-jp", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-jp", main_of(&conn, deck.id), 4);
        // What the next sync does to a printing Scryfall stopped publishing.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-jp'", [])
            .unwrap();

        let detail = get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap();

        assert_eq!(detail.cards.len(), 1, "listed, never dropped");
        let row = &detail.cards[0];
        assert_eq!(
            (
                row.name.as_str(),
                row.set_code.as_str(),
                row.collector_number.as_str(),
                row.lang.as_str(),
                row.quantity
            ),
            ("Lightning Bolt", "4ed", "209", "ja", 4),
            "everything the row was written with, and it was written with it for this day"
        );
        assert_eq!(
            row.category_name.as_str(),
            "Main deck",
            "its category is a row of its own and has not gone anywhere"
        );
        assert!(row.oracle_id.is_none());
        assert!(row.legalities.is_none());
        assert!(row.type_line.is_none());
        assert!(row.unit_price.is_none());
        assert!(
            !row.ever_uncommon,
            "nothing is known, so nothing is claimed"
        );
        assert_eq!(
            row.owned_quantity, 0,
            "an oracle card nobody can name is an oracle card nobody can count copies of"
        );
    }

    /// NULL power **and** NULL toughness is UNKNOWN, never "no P/T box" — and the difference
    /// is the whole of CR 903.3 (2026): a legendary Vehicle *with* a P/T box can be a
    /// commander and one without cannot. Only 1 510 of 116 590 rows have the columns filled
    /// until the user's next real sync, so the read recovers them from `raw` — which is a
    /// **gzip BLOB**, where `json_extract` is a hard error and only Rust can look.
    #[test]
    fn an_unknown_power_and_toughness_is_recovered_from_the_raw_blob() {
        let conn = seeded();
        let ship = r#"{"object":"card","name":"Skysovereign, Consul Flagship","power":"6","toughness":"5"}"#;
        let delver = r#"{"object":"card","name":"Delver of Secrets","card_faces":[{"name":"Delver of Secrets","power":"1","toughness":"1"},{"name":"Insectile Aberration","power":"3","toughness":"2"}]}"#;
        // A land whose blob *lies*: no land has a P/T, so these keys can only be reached by
        // a lookup — which is exactly what the type gate must not make. If the gate ever
        // goes, this row starts reading 9/9 and says so.
        let island = r#"{"object":"card","name":"Island","power":"9","toughness":"9"}"#;
        // No type line at all: unknown, so it is looked at — the conservative direction.
        let nameless = r#"{"object":"card","name":"Mystery","power":"2","toughness":"3"}"#;
        for (id, oracle, name, set, cn, type_line, raw) in [
            (
                "ship",
                "o3",
                "Skysovereign, Consul Flagship",
                "kld",
                "234",
                Some("Legendary Artifact — Vehicle"),
                ship,
            ),
            (
                "delver",
                "o4",
                "Delver of Secrets // Insectile Aberration",
                "isd",
                "51",
                Some("Creature — Human Wizard"),
                delver,
            ),
            (
                "island",
                "o5",
                "Island",
                "isd",
                "255",
                Some("Basic Land — Island"),
                island,
            ),
            ("mystery", "o6", "Mystery", "ust", "1", None, nameless),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,raw)
                 VALUES (?1,?2,?3,?4,?5,'en','normal','rare',?6,?7)",
                params![
                    id,
                    oracle,
                    name,
                    set,
                    cn,
                    type_line,
                    crate::card_row::gzip_raw(raw)
                ],
            )
            .unwrap();
        }
        let deck = create_deck(&conn, &input("Vehicles", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        let commander = kind_of(&conn, deck.id, "commander");
        add(&conn, deck.id, "ship", commander, 1);
        add(&conn, deck.id, "delver", main, 4);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "island", main, 20);
        add(&conn, deck.id, "mystery", main, 1);

        let stored: Option<String> = conn
            .query_row("SELECT power FROM cards WHERE id = 'ship'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            stored.is_none(),
            "the column is empty until the next sync — that is the case under test"
        );

        let detail = get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap();

        let ship = card_row(&detail, "ship", commander);
        assert_eq!(
            (ship.power.as_deref(), ship.toughness.as_deref()),
            (Some("6"), Some("5")),
            "a Vehicle WITH a P/T box can be a commander; unknown must never read as `no box`"
        );
        let delver = card_row(&detail, "delver", main);
        assert_eq!(
            (delver.power.as_deref(), delver.toughness.as_deref()),
            (Some("1"), Some("1")),
            "the front face's, like every other per-face fallback in this app"
        );
        let bolt = card_row(&detail, "bolt-lea", main);
        assert!(
            bolt.power.is_none() && bolt.toughness.is_none(),
            "and an Instant really has no P/T box — recovery is not invention"
        );

        // The gate, in the only way it can be observed: a land whose blob carries a P/T is
        // read as having none, because the blob is never opened. On a fully synced database
        // this is most of every deck — every land, instant, sorcery, enchantment and
        // ordinary artifact has both columns NULL *correctly*, and an ungated recovery would
        // inflate a 2 KB blob for each of them on every read, for ever, and find nothing.
        let island = card_row(&detail, "island", main);
        assert!(
            island.power.is_none() && island.toughness.is_none(),
            "a Land's blob is never opened — no type that prints a P/T box, no lookup"
        );
        // …and an unknown type line is still looked at, because unknown is not `no`.
        let mystery = card_row(&detail, "mystery", main);
        assert_eq!(
            (mystery.power.as_deref(), mystery.toughness.as_deref()),
            (Some("2"), Some("3"))
        );
    }

    /// The gate itself, over the type lines that decide it. `Vehicle` and `Spacecraft` are
    /// on the list for CR 903.3's reason, and the combined type line of a transform card is
    /// why a back-face creature needs no special case.
    #[test]
    fn only_a_type_line_that_could_print_a_power_toughness_box_is_worth_a_lookup() {
        for worth in [
            "Creature — Human Wizard",
            "Legendary Artifact — Vehicle",
            "Artifact — Spacecraft",
            "Land Creature — Forest Dryad",
            "Land // Legendary Creature — Demon",
        ] {
            assert!(may_have_a_power_toughness_box(Some(worth)), "{worth}");
        }
        for not in [
            "Instant",
            "Sorcery",
            "Basic Land — Island",
            "Enchantment — Aura",
            "Legendary Planeswalker — Jace",
            "Artifact — Equipment",
        ] {
            assert!(!may_have_a_power_toughness_box(Some(not)), "{not}");
        }
        assert!(
            may_have_a_power_toughness_box(None),
            "unknown is not `no`: an orphan, or a row that arrived without a type line"
        );
    }

    /// `missing_to_wishlist`: 4 wanted, 1 owned → an any-printing wish for 3 lands through
    /// the wishlist grain; run twice → the wish is 6 (the fold is `add_wish`'s contract, not
    /// double-counted rows); a fully-owned card adds nothing; an inactive category and the
    /// theory list never count.
    #[test]
    fn missing_to_wishlist_writes_any_printing_wishes_through_the_wishlist_grain() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        // **In the deck's own group, not merely in the collection.** A shopping list is about
        // what this deck is short of, and since schema v25 a copy the reader owns but has not
        // put in the deck is a copy the deck does not have.
        file_into_group(&conn, deck.id, "bolt-lea", 1);
        file_into_group(&conn, deck.id, "serra-lea", 1);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "serra-lea", main, 1);
        // The same oracle card as the main-deck Bolts, so a scratchpad or a plan that leaked
        // into the shortfall would change the number rather than merely add a row.
        add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "maybe"),
            3,
        );
        add_card(
            &conn,
            deck.id,
            "bolt-m10",
            Some(main),
            None,
            THEORY,
            None,
            3,
        )
        .unwrap();

        let touched = missing_to_wishlist(&conn, deck.id).unwrap();

        assert_eq!(touched, 1, "one card is short; the Angel is not");
        let wishes: Vec<(Option<String>, Option<String>, String, i64)> = conn
            .prepare("SELECT oracle_id, card_id, name, quantity FROM wishlist_entries")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            wishes,
            vec![(Some("o1".to_owned()), None, "Lightning Bolt".to_owned(), 3)],
            "any printing will do — a shopping list is not a printing preference"
        );

        assert_eq!(missing_to_wishlist(&conn, deck.id).unwrap(), 1);
        let (rows, quantity): (i64, i64) = conn
            .query_row(
                "SELECT count(*), sum(quantity) FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (rows, quantity),
            (1, 6),
            "the grain folds the repeat — one line, a bigger number"
        );
    }

    /// The rules as data, all the way out to the frontend: the nullable cells are the ones
    /// worth a fence, because `NULL` means *unlimited* here and `0` means *none*.
    #[test]
    fn the_format_specs_read_carries_every_cell_including_the_nullable_ones() {
        let conn = seeded();

        let specs = list_format_specs(&conn).unwrap();

        assert_eq!(specs.len(), 25);
        assert_eq!(specs[0].key, "standard", "sort_order, not alphabetical");
        let spec = |key: &str| specs.iter().find(|s| s.key == key).unwrap();
        let edh = spec("commander");
        assert_eq!(
            (
                edh.display_name.as_str(),
                edh.deck_min,
                edh.deck_max,
                edh.max_copies,
                edh.sideboard_max,
                edh.singleton,
                edh.requires_commander,
                edh.commander_rule.as_deref(),
                edh.life,
                edh.allows_companion,
            ),
            (
                "Commander",
                100,
                Some(100),
                Some(1),
                Some(0),
                true,
                true,
                Some("edh"),
                40,
                true
            ),
            "sideboard_max 0 is NO sideboard, and EDH still allows a companion"
        );
        let casual = spec("casual");
        assert_eq!(
            (
                casual.deck_max,
                casual.max_copies,
                casual.sideboard_max,
                casual.has_legality_data,
                casual.commander_rule.as_deref(),
            ),
            (None, None, None, false, None),
            "NULL is unlimited, and a pseudo-format checks no legality at all"
        );
        assert_eq!(
            spec("duel").restricted_semantic,
            "banned_as_commander",
            "TRAP A rides the read: `restricted` means something else here"
        );
        assert_eq!(spec("tlr").max_mana_value, Some(3));
        assert!(!spec("future").enabled_in_picker);
        assert!(!spec("gladiator").allows_companion);

        // `games` arrives **split**, which is the one cell whose storage shape and wire shape
        // differ — see [`FormatSpecRow::games`]. The three sampled here are the three answers
        // that are not the widest one, because the widest one is also the DDL default and would
        // read correct on a column the re-seed had never touched.
        assert_eq!(spec("modern").games, ["paper", "mtgo"]);
        assert_eq!(spec("historic").games, ["arena"]);
        assert_eq!(spec("penny").games, ["mtgo"]);
        assert_eq!(spec("casual").games, ["paper", "arena", "mtgo"]);
        for s in &specs {
            assert!(
                !s.games.is_empty(),
                "`{}` names no platform, so no filtered picker could ever offer it",
                s.key
            );
        }
    }

    /// A deck carries a platform, it survives the round trip, and it is refused by name.
    ///
    /// **The format is not checked against it**, which is the assertion that matters most here:
    /// a Modern deck may say Arena. The pair is the reader's and the game narrows a *picker*,
    /// so a create or a patch that refused the combination would be refusing a deck over a
    /// filter — and `pickerFormats`' `keep` is what keeps such a deck's own format on screen.
    #[test]
    fn a_deck_carries_a_game_and_an_unknown_one_is_refused_by_name() {
        let conn = seeded();

        let born = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                format_key: "modern".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            born.game_key, DEFAULT_GAME,
            "a deck nobody asked is `any`, which is the column's own default"
        );

        let arena = update_deck(
            &conn,
            born.id,
            &DeckPatch {
                game_key: Some("arena".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(arena.game_key, "arena");
        assert_eq!(
            arena.format_key, "modern",
            "setting the game moves no format — Modern is not an Arena format and the deck is \
             still a Modern deck"
        );

        let history = crate::deck_audit::list(&conn, born.id, 10).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&history[0].payload).unwrap(),
            serde_json::json!({ "field": "game", "from": "any", "to": "arena" }),
            "the key, never a display word: `auditText.ts` is the only thing that words a row"
        );

        let err = update_deck(
            &conn,
            born.id,
            &DeckPatch {
                game_key: Some("gameboy".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            err.contains("gameboy") && err.contains("mtgo"),
            "the refusal names the value and quotes the vocabulary: {err}"
        );
        assert_eq!(
            read_deck(&conn, born.id).unwrap().unwrap().game_key,
            "arena",
            "and the refused write changed nothing"
        );

        // Blank is the DDL default rather than a wrong answer — `valid_format`'s rule, applied
        // to the column beside it, so a caller that sends `""` gets a working deck.
        let back = update_deck(
            &conn,
            born.id,
            &DeckPatch {
                game_key: Some("  ".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(back.game_key, DEFAULT_GAME);
    }

    // Undoing a game change is `deck_undo.rs`'s `deck_update (game)` case, driven there over
    // the same sweep every other deck-level column goes through.

    /// **A deck card carries the front face's image URL** — what the editor's Grid and Stacks
    /// views have no other way to draw a picture from in a browser.
    ///
    /// `mtgimg://` is a Tauri custom protocol and wasm cannot register one with a browser, so
    /// without this a deck opened on the web build is a wall of named, artless frames.
    ///
    /// **`bolt-m10` is the row that makes the offset visible at all.** The pair starts directly
    /// after `c.promo_types`, and with only top-level pictures in the fixture a read one column
    /// early lands the top-level URL in the `face` slot and answers correctly anyway — the
    /// mutation survived exactly that way. A `meld`-shaped row carrying **both** columns is the
    /// only shape where the shifted read gives a different, wrong answer, and it pins the
    /// face-first precedence in the same breath.
    ///
    /// **Both variants, since 2026-08-31**, and the second one is a second way for the offset
    /// to be wrong rather than more of the same: with `display` and `art` the select list is
    /// four expressions, and a read that pairs them up wrong hands the crop back under
    /// `display` — still a URL, still on the image host, still versioned, and the wrong
    /// picture. Every row here therefore carries a *different* URL per variant per column.
    #[test]
    fn a_deck_card_carries_the_front_faces_image_url() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET image_uris = json_object(
                 'thumb','https://cards.scryfall.io/thumb/front/0/0/x.webp?17',
                 'grid','https://cards.scryfall.io/grid/front/0/0/x.webp?17',
                 'display','https://cards.scryfall.io/display/front/0/0/x.webp?17',
                 'art','https://cards.scryfall.io/art/front/0/0/x.webp?17')
             WHERE id = 'bolt-lea'",
            [],
        )
        .unwrap();
        // Scryfall's own error page: a URL with nothing to invalidate, on a host that does not
        // serve card art. It must read as *no picture*, not as a URL a browser will request.
        conn.execute(
            "UPDATE cards SET image_uris = json_object(
                 'display','https://errors.scryfall.com/soon.jpg')
             WHERE id = 'bolt-jp'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE cards SET
                 image_uris = json_object(
                     'display','https://cards.scryfall.io/display/top.webp?1',
                     'art','https://cards.scryfall.io/art/top.webp?1'),
                 face_image_uris = json_array(json_object(
                     'display','https://cards.scryfall.io/display/face0.webp?1',
                     'art','https://cards.scryfall.io/art/face0.webp?1'))
             WHERE id = 'bolt-m10'",
            [],
        )
        .unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-jp", main, 1);
        add(&conn, deck.id, "bolt-m10", main, 1);
        // `serra-lea` carries neither image column, which is the ordinary state of 162 of the
        // live corpus's 117 606 rows.
        add(&conn, deck.id, "serra-lea", main, 1);

        let detail = get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap();
        let row = card_row(&detail, "bolt-lea", main);
        let art = row
            .image_uris
            .as_ref()
            .expect("a versioned URL on the image host is a picture");
        assert_eq!(
            art[crate::image_uri::LIST_VARIANT],
            "https://cards.scryfall.io/display/front/0/0/x.webp?17"
        );
        assert_eq!(
            art[crate::image_uri::ART_VARIANT],
            "https://cards.scryfall.io/art/front/0/0/x.webp?17",
            "the crop, under its own key — a pairing read wrong swaps these two"
        );
        // Spelled out rather than read off `LIST_VARIANTS`, for the reason
        // `a_deck_row_carries_the_cover_printings_art` gives: a widening has to edit a test.
        assert_eq!(
            art.keys().map(String::as_str).collect::<Vec<_>>(),
            ["art", "display"],
            "every variant a list row carries, and nothing else"
        );
        // The two columns an off-by-one would have reached, both still plausible strings.
        assert_eq!(row.promo_types, None, "the column directly before the pair");
        assert_eq!(row.finish, None);

        // The precedence **and** the offset, for both variants. See the doc above for why no
        // other row here can fail when the pair is read a column early.
        let meld = card_row(&detail, "bolt-m10", main)
            .image_uris
            .as_ref()
            .expect("a meld-shaped printing has a front face");
        assert_eq!(
            meld[crate::image_uri::LIST_VARIANT],
            "https://cards.scryfall.io/display/face0.webp?1",
            "the face wins over the top-level blob, and the pair is read at its own offset"
        );
        assert_eq!(
            meld[crate::image_uri::ART_VARIANT],
            "https://cards.scryfall.io/art/face0.webp?1",
            "and the second variant's pair is read at its own offset too"
        );

        assert_eq!(
            card_row(&detail, "bolt-jp", main).image_uris,
            None,
            "an error page is a gap, not a picture"
        );
        assert_eq!(
            card_row(&detail, "serra-lea", main).image_uris,
            None,
            "a printing with neither image column carries nothing"
        );
    }

    #[test]
    fn deck_card_and_format_spec_json_use_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckCardRow {
            id: 7,
            card_id: "bolt-lea".to_owned(),
            category_id: 2,
            category_name: "Main deck".to_owned(),
            category_kind: "main".to_owned(),
            category_active: true,
            variant: "live".to_owned(),
            label_id: Some(5),
            label_name: Some("Flex".to_owned()),
            label_color: Some("amber".to_owned()),
            quantity: 4,
            name: "Lightning Bolt".to_owned(),
            set_code: "lea".to_owned(),
            set_name: Some("Limited Edition Alpha".to_owned()),
            collector_number: "161".to_owned(),
            lang: "en".to_owned(),
            needs_review: None,
            oracle_id: Some("o1".to_owned()),
            mana_cost: Some("{R}".to_owned()),
            cmc: Some(1.0),
            type_line: Some("Instant".to_owned()),
            oracle_text: Some("Deal 3 damage.".to_owned()),
            colors: Some("R".to_owned()),
            color_identity: Some("R".to_owned()),
            legalities: Some(r#"{"modern":"legal"}"#.to_owned()),
            power: None,
            toughness: None,
            layout: Some("normal".to_owned()),
            rarity: Some("common".to_owned()),
            faces: None,
            game_changer: Some(false),
            finishes: Some(r#"["nonfoil","foil"]"#.to_owned()),
            ever_uncommon: false,
            unit_price: Some(400.0),
            // Set rather than `None`, so the wire name is pinned by a value the frontend can
            // tell from an absent key: `finish` is what every deck surface reads to draw the
            // sheen and what every card command addresses by.
            finish: Some("foil".to_owned()),
            // The printing's, not the row's: this deck sleeves the foil copy, and the column
            // beside it is what names which foil that is.
            promo_types: Some(r#"["surgefoil"]"#.to_owned()),
            owned_quantity: 3,
            image_uris: Some(BTreeMap::from([(
                crate::image_uri::LIST_VARIANT.to_owned(),
                "https://cards.scryfall.io/display/front/0/0/x.webp?17".to_owned(),
            )])),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 7, "cardId": "bolt-lea", "categoryId": 2, "categoryName": "Main deck",
                "categoryKind": "main", "categoryActive": true, "variant": "live",
                "labelId": 5, "labelName": "Flex", "labelColor": "amber", "quantity": 4,
                "name": "Lightning Bolt", "setCode": "lea",
                "setName": "Limited Edition Alpha", "collectorNumber": "161",
                "lang": "en", "needsReview": null, "oracleId": "o1", "manaCost": "{R}",
                "cmc": 1.0, "typeLine": "Instant", "oracleText": "Deal 3 damage.",
                "colors": "R", "colorIdentity": "R",
                "legalities": "{\"modern\":\"legal\"}", "power": null, "toughness": null,
                "layout": "normal", "rarity": "common", "faces": null,
                "gameChanger": false, "finishes": "[\"nonfoil\",\"foil\"]",
                "everUncommon": false, "unitPrice": 400.0, "finish": "foil",
                "promoTypes": "[\"surgefoil\"]",
                "ownedQuantity": 3,
                "imageUris": {
                    "display": "https://cards.scryfall.io/display/front/0/0/x.webp?17"
                }
            })
        );

        let conn = seeded();
        let spec = serde_json::to_value(&list_format_specs(&conn).unwrap()[11]).unwrap();
        assert_eq!(
            spec,
            serde_json::json!({
                "key": "commander", "displayName": "Commander", "enabledInPicker": true,
                "deckMin": 100, "deckMax": 100, "maxCopies": 1, "sideboardMax": 0,
                "singleton": true, "requiresCommander": true, "commanderRule": "edh",
                "life": 40, "restrictedSemantic": "max_one", "hasLegalityData": true,
                "maxManaValue": null, "allowsCompanion": true, "sortOrder": 12,
                // An **array**, not the comma-joined string the column holds: the split is
                // `list_format_specs`' and this is what pins that it happens before the wire.
                "games": ["paper"]
            })
        );

        // The wrapper the command actually answers with: an empty deck still names its four
        // categories, because that is what the editor draws before anything is in it.
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let detail =
            serde_json::to_value(get_deck(&conn, deck.id, LIVE, ANY_MARKET).unwrap().unwrap())
                .unwrap();
        assert_eq!(detail["deck"]["formatKey"], "modern");
        assert_eq!(detail["cards"], serde_json::json!([]));
        assert_eq!(detail["labels"], serde_json::json!([]));
        assert_eq!(detail["categories"].as_array().unwrap().len(), 4);
        assert_eq!(detail["categories"][0]["name"], "Commander");
        assert_eq!(detail["categories"][0]["isActive"], true);
    }
}
