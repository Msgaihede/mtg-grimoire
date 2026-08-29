//! The wishlist: what the user is hunting for, at the grain spec §6 gives it — an oracle
//! card, optionally pinned to one printing and one finish.
//!
//! The interesting column is `card_id`, and it is interesting because it is **nullable**:
//! NULL means "any printing", which is what a wishlist usually means, and a value means
//! "that one", which is what it means once someone has decided they want the Alpha.
//!
//! Shaped like [`crate::collection`] — pure functions over a `Connection`, wrapped in
//! `async` commands that take the *write* connection with a bound — with one deliberate
//! difference: `quantity > 0` is a table CHECK here, so there is no zero-keeps-the-row
//! state to preserve. A wish for none of something is not a wish, and [`set_wish_quantity`]
//! takes a zero as the removal it can only be.

use crate::collection::{valid_quantity, EntryChange};
// The refusal a folder id nothing answers to gets, reached across rather than re-spelled —
// `wishlist_folders`' own import of it makes the same argument at length, and this is the third
// write over `wishlist_entries.folder_id` to need the sentence.
use crate::deck_meta::FOLDER_GONE;
use crate::filters::{escape_like, LIKE_ESCAPE};
use crate::schema::{FINISHES, WISHLIST_GRAIN};
#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// One wish, as the UI sends it.
///
/// Either identifier will do. A caller that sends only `cardId` gets the oracle id and the
/// name looked up from that printing (which is how the "any printing" button on a card can
/// work from a card); a caller that sends only `oracleId` gets the name looked up from any
/// printing of that oracle card, and must send one itself when the card database has none
/// — an oracle id whose printings have all left `cards` still makes a wish, and a shopping
/// list that cannot say what it is shopping for is not a list.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WishInput {
    pub card_id: Option<String>,
    pub oracle_id: Option<String>,
    pub name: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    pub notes: Option<String>,
    /// Where to file the wish. **Absent is the root**, which is where every wish landed
    /// before schema v23 and where every wish still lands unless a menu names a folder —
    /// nothing has to be created for the list to work.
    ///
    /// It is the fourth term of [`WISHLIST_GRAIN`], which is what makes "Add to Ordered" an
    /// **add** rather than a move: the conflict target already includes the folder, so a
    /// wish for a card the reader filed last week and a wish for the same card added today
    /// at the root are two rows, and no `DO UPDATE` clause below touches this column. It
    /// could not usefully be in one — an add that reached across folders would undo a filing
    /// decision as a side effect of shopping, and moving a wish between folders is its own
    /// explicit act (`wishlist_folders::set_wish_folder`).
    ///
    /// **Fenced in words against `wishlist_folders`**, and the foreign key is not the reason
    /// it needs to be. The column really does carry one (`ON DELETE SET NULL`), so an id
    /// naming no folder is refused on the insert — with `FOREIGN KEY constraint failed`, which
    /// names the constraint and not the mistake, and only while `PRAGMA foreign_keys` happens
    /// to be on. `wishlist_folders::set_wish_folder` and `wishlist_folders::move_folder` both
    /// look the id up and answer [`FOLDER_GONE`] instead, over the same column, and the three
    /// writes disagreeing about it was a reader deleting a folder in one pane and being told
    /// `FOREIGN KEY constraint failed` by **Add to → Wishlist → Ordered** while
    /// **Move to folder…** said "That folder is not there any more." One mistake, one wording.
    pub folder_id: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WishlistQuery {
    #[serde(flatten)]
    pub cards: crate::filters::CardFilters,
    /// `Some(true)` shows only wishes the collection already covers, `Some(false)` only
    /// those it does not — "what is still missing" being the list's usual question.
    pub fulfilled: Option<bool>,
    /// `Some(true)` narrows to the wishes a Scryfall migration or a vanished printing
    /// flagged. [`crate::collection::CollectionQuery`]'s field, verbatim: the reconciler
    /// walks both tables, so both lists answer the same question the same way.
    pub needs_review: Option<bool>,
    /// How to order the list: columns in priority order, the first deciding and the rest
    /// breaking its ties. Empty or absent is name order. Keys outside [`WISHLIST_SORTS`]
    /// are dropped, never interpolated.
    pub sort: Option<Vec<crate::sorting::SortTerm>>,
    /// Where to quote prices from, and therefore what the `cost` and `price` sorts order by.
    /// Absent — or anything this build does not recognise — means `tcgplayer`.
    /// [`crate::collection::CollectionQuery`]'s field, verbatim; see
    /// [`crate::sorting::Marketplace`].
    pub marketplace: crate::sorting::Marketplace,
    /// Which folder the list is being read at. `None` is the **root** — a real place with
    /// wishes in it, not the absence of a question — and it is read as one only when
    /// [`WishlistQuery::flatten`] is false.
    ///
    /// Direct members only: a folder's page lists what is filed *in it*, never what is filed
    /// in the folders inside it. The gallery's tree does the summing, for the reason
    /// `wishlist_folder_summary` gives — SQL that walked the tree would be a second
    /// implementation of arithmetic `folderTree.ts` already does.
    pub folder_id: Option<i64>,
    /// `true` ignores [`WishlistQuery::folder_id`] entirely and answers every wish, wherever
    /// it is filed — the page's **Flatten** switch.
    ///
    /// **This is what tells "the root" apart from "no folder filter"; a nullable field alone
    /// cannot.** `folder_id: None` already means the root, so there is no value left in that
    /// field for "do not filter by folder at all", and a second field is the only way to ask
    /// the question. Default `false`, so every caller written before folders existed keeps
    /// reading the root — which is the list it has always shown.
    pub flatten: bool,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishRow {
    pub id: i64,
    pub oracle_id: Option<String>,
    /// `None` = any printing.
    pub card_id: Option<String>,
    pub name: String,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    pub lang: Option<String>,
    pub rarity: Option<String>,
    pub mana_cost: Option<String>,
    /// The joined card's type line, and it is here for exactly one reader: a **pinned wish
    /// dragged onto the sidebar's Decks entry**, which lands in a deck with no column to have
    /// been pointed at. The pile is then named by TypeScript's `autoCategoryFor`, whose only
    /// input this is — so without it a wish carried into a deck would file under
    /// `Uncategorised` while the same card carried from the search wall filed under `Creature`.
    ///
    /// `None` exactly when the `LEFT JOIN` found nothing — which is **not** the same as an
    /// any-printing wish, because that join coalesces to the cheapest printing of the wish's
    /// oracle card. So a wish for the card is described as well as a wish for the cardboard,
    /// and only a genuine orphan (no pinned printing, no oracle match) answers `None`. Same
    /// `None` as `rarity` and `mana_cost` beside it, for the same reason.
    pub type_line: Option<String>,
    /// The printing this wish is **drawn as** — the id of the card the `LEFT JOIN` found.
    ///
    /// It is not `card_id` and must never be read as one. `card_id` is what the wish is *for*
    /// and is `None` for an any-printing wish; this is what there is a picture of, which the
    /// join answers for both kinds: a pinned wish resolves to its own printing, an unpinned one
    /// to the **cheapest** printing of its oracle card at the marketplace the query named — the
    /// printing a reader acting on the wish would actually buy, which is why the picture and
    /// [`Self::unit_price`] come off one join rather than two rules. So the wall can draw every
    /// wish while the caption goes on saying "Any printing" for the ones that are for the card
    /// rather than for the cardboard — spec §6's distinction, which a picture must not quietly
    /// settle.
    ///
    /// **An oracle card no marketplace quotes keeps the newest printing**, which the ordering's
    /// tiebreak is there for: a hole in a pricelist must not cost a wish its art.
    ///
    /// `None` exactly where `type_line`, `rarity` and `mana_cost` beside it are: a genuine
    /// orphan, no pinned printing in `cards` and no oracle match. That tile draws the no-art
    /// frame with the name, as the deck's Grid view does for the same state.
    pub art_card_id: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    /// The cheapest way to satisfy this wish, per copy, at the marketplace the query named:
    /// the preferred finish's price if one is named, else the printing's own
    /// `nonfoil → foil → etched` chain — over the **cheapest** printing of the oracle card, for
    /// an unpinned wish, which is the same printing [`Self::art_card_id`] draws.
    ///
    /// Carries whatever hole that marketplace has. On Cardmarket a wish for the *etched*
    /// printing is unpriced rather than quoted at the nonfoil rate — **`eur_etched` does not
    /// exist** — while Mana Pool, which publishes an etched column, answers with a number.
    /// [`crate::sorting::row_price_expr`]'s rule over [`WISH_PREFERRED_FINISH`].
    pub unit_price: Option<f64>,
    /// How many copies the collection already has against this wish.
    pub owned_quantity: i64,
    pub notes: Option<String>,
    pub needs_review: Option<String>,
    pub updated_at: i64,
    /// JSON, verbatim: the joined printing's `legalities` object — the fact the Arena export
    /// filter reads, and the only reader it has. [`crate::collection::CollectionRow::legalities`]
    /// carries the argument for the blob over `legal_mask`, and the same `None`-is-an-orphan
    /// rule as [`Self::type_line`] above: the `LEFT JOIN` coalesces an any-printing wish to the
    /// cheapest printing of its oracle card, so only a genuine orphan answers `None`.
    pub legalities: Option<String>,
    /// Where the wish is filed. `None` is the root, and it is on every row rather than
    /// implied by the query because the **Flatten** view asks for every wish at once and
    /// then has to say where each one lives.
    pub folder_id: Option<i64>,
    /// How many **other** wishes are on the list for the same oracle card — in another
    /// folder, at the root, pinned to another printing, in another finish. `0` is the
    /// ordinary answer and the row draws nothing.
    ///
    /// This is the mitigation for the price [`WISHLIST_GRAIN`]'s fourth term charges: three
    /// writers add at the root and cannot name a folder (`deck_missing_to_wishlist`,
    /// `deck_theory_missing_to_wishlist` and `wishlist_import_commit`), so a deck sweep over
    /// a card the reader already filed in `Ordered` makes a *second* root row — which is the
    /// double-order the folders exist to prevent. A row that says "also on your list" turns
    /// that from a trap into a note.
    ///
    /// Counted in **SQL, over the whole table**, rather than in TypeScript over the page:
    /// the list is paged and a page cannot see the wishes it did not fetch, so the same
    /// count done in the frontend would answer `0` for exactly the pair that is split across
    /// two pages. A wishlist is tens of rows, so the correlated count is cheap.
    ///
    /// `0` on an orphan with no oracle id, and that is a fence rather than a coincidence —
    /// see the subquery's own comment in [`list_wishes`].
    pub elsewhere: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistPage {
    pub items: Vec<WishRow>,
    pub total: i64,
}

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// How many copies the collection holds against a wish, as a scalar subquery.
///
/// **Every term of the wish narrows it**, which is the same statement
/// [`WISHLIST_GRAIN`] makes about what separates one wish from another:
///
/// * the printing — a pinned wish counts that printing, an unpinned one counts every
///   printing of the oracle card, which is what "any printing" means on the way back as
///   well as on the way out;
/// * the finish — a wish *for the foil* is not satisfied by the nonfoil sitting in a
///   binder. That is why the finish is in the grain in the first place: a foil wish and a
///   nonfoil wish are two wishes, and counting either against the other would make the
///   third term of the grain a distinction the list itself does not believe in. A wish that
///   names no finish takes any of them, which is what "no preference" means.
///
/// Condition is deliberately *not* a term: a wishlist has nowhere to say "and in NM", so
/// there is nothing to match against, and a played copy is still a copy of the card.
///
/// `sum(quantity)`, so a collection row holding no copies contributes nothing: this figure is
/// copies held, not entries recorded, and a wish is satisfied by copies. **Since schema v24 a
/// row taken to zero is deleted rather than kept** ([`crate::collection::set_quantity`]), so the
/// only zero row that can still reach this sum is one [`crate::collection::update_entry`] left —
/// the edit form must not delete its own subject. The arithmetic is the same either way, which
/// is why it is written as a statement about copies rather than about which rows exist.
///
/// **It narrows by finish and never by condition.**
///
/// **`pub(crate)` for one reader outside this module**: `wishlist_folders::folder_summary` sums
/// `max(0, quantity - owned)` per folder, so a folder's subtotal and the page header's total have
/// to be one piece of arithmetic and a second spelling would be a second thing to keep in step.
/// The alias `w` this expression assumes is part of the contract, so anything reading it aliases
/// `wishlist_entries` the same way.
pub(crate) const OWNED_SQL: &str = "coalesce((
        SELECT sum(ce.quantity) FROM collection_entries ce
         WHERE (w.card_id IS NOT NULL AND ce.card_id = w.card_id
                AND (w.preferred_finish IS NULL OR ce.finish = w.preferred_finish))
            OR (w.card_id IS NULL AND ce.card_id IN
                    (SELECT id FROM cards WHERE oracle_id = w.oracle_id)
                AND (w.preferred_finish IS NULL OR ce.finish = w.preferred_finish))), 0)";

/// The columns the wishlist's headers can sort on, plus the two the filter bar's select
/// offers that have no column to press.
///
/// **There is no `set` order, and the Printing column is not a header you can press.** An
/// any-printing wish names no set, and a list where half the rows sort under the same blank
/// is not an order.
///
/// `cost` and `price` are not here — they are the two keys whose SQL depends on the reader's
/// marketplace, so they live in [`WISHLIST_PRICE_SORTS`] and are appended by
/// [`crate::sorting::sorts_for`].
const WISHLIST_SORTS: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "w.name ASC",
        desc: "w.name DESC",
    },
    crate::sorting::SortColumn {
        key: "owned",
        asc: "owned_quantity ASC",
        desc: "owned_quantity DESC",
    },
    crate::sorting::SortColumn {
        key: "quantity",
        asc: "w.quantity ASC",
        desc: "w.quantity DESC",
    },
    // The id carries the rest of the answer, and it is not the builder's tiebreak doing it:
    // `created_at` is whole seconds, so a handful of wishes made in one go all share one,
    // and the appended `w.id ASC` would read them out oldest-first under a heading that
    // says "Recently added". The duplicate id term the builder then appends is unreachable
    // and harmless — the same shape `search`'s `ORDER_NAME` has.
    crate::sorting::SortColumn {
        key: "added",
        asc: "w.created_at ASC, w.id ASC",
        desc: "w.created_at DESC, w.id DESC",
    },
];

/// `cost` and `price` — the two keys that turn on the reader's marketplace.
///
/// `cost` is what finishing the wish still costs — unit price over the copies *missing*,
/// which is the figure the Cost cell prints and which is zero for a fulfilled wish however
/// dear the card is. `price` is what one copy costs, and stays reachable from the select.
///
/// Both order by the **output alias** rather than by any column of either table, so a rename
/// there is a `prepare` error at run time; `every_sort_key_prepares…` is what catches it, and
/// it runs every key at every marketplace. Whatever hole the chosen marketplace has rides
/// along: on Cardmarket a wish for the *etched* printing is NULL and sorts last, because
/// there is no `eur_etched` key to quote it from.
const WISHLIST_PRICE_SORTS: &[crate::sorting::PricedSort] = &[
    crate::sorting::PricedSort {
        key: "cost",
        asc: "{price} * max(0, w.quantity - owned_quantity) ASC NULLS LAST",
        desc: "{price} * max(0, w.quantity - owned_quantity) DESC NULLS LAST",
    },
    crate::sorting::PricedSort {
        key: "price",
        asc: "{price} ASC NULLS LAST",
        desc: "{price} DESC NULLS LAST",
    },
];

/// What the page calls its price column, and therefore what its money sorts order by.
const UNIT_PRICE_ALIAS: &str = "unit_price";

/// The wish's own finish column, for [`crate::sorting::row_price_expr`] to branch on.
///
/// **It was `coalesce(w.preferred_finish, 'nonfoil')` and that coalesce was the bug.** "No
/// preference" is not nonfoil — it is a wish for the *card*, which is exactly what a deck row
/// with a null finish is, and 12 849 of 116 843 printings have no nonfoil price at any
/// marketplace. Reading the null as nonfoil left FIC #477 (sold only in foil, `usd_foil` 31.18)
/// drawing an em dash on the wishlist beside a search wall quoting it.
///
/// The column is handed over **unwrapped** now, so `row_price_expr` can tell "the reader has not
/// said" from "the reader said nonfoil" — which are two different wishes and, on a printing sold
/// only in foil, two different answers.
///
/// [`crate::collection::ENTRY_FINISH`]'s counterpart, over the wish's own column rather than
/// over an entry's.
pub const WISH_PREFERRED_FINISH: &str = "w.preferred_finish";

pub fn add_wish(conn: &Connection, input: &WishInput) -> Result<EntryChange, String> {
    if let Some(f) = input.preferred_finish.as_deref() {
        if !FINISHES.contains(&f) {
            return Err(format!(
                "`{f}` is not a finish. Use one of: {}.",
                FINISHES.join(", ")
            ));
        }
    }
    let quantity = if input.quantity <= 0 {
        1
    } else {
        input.quantity
    };
    // Trimmed, and blank read as absent — **before** anything below asks whether an id is
    // there. `nonblank` is the same rule the filters apply, and it is load-bearing here in
    // a way it is not there: the table's `CHECK (oracle_id IS NOT NULL OR card_id IS NOT
    // NULL)` is satisfied by an empty string, and [`WISHLIST_GRAIN`] coalesces NULL to `''`
    // — so a wish arriving with `oracleId: ""` would pass every guard and then land on the
    // grain `('', '', '')`, which every *other* blank-id wish would fold into. One row,
    // silently accumulating unrelated cards' quantities. A form's cleared field is the
    // ordinary way to send one.
    let card_id = crate::filters::nonblank(&input.card_id).map(str::to_owned);
    let sent_oracle_id = crate::filters::nonblank(&input.oracle_id).map(str::to_owned);
    let sent_name = crate::filters::nonblank(&input.name).map(str::to_owned);
    // Asked before anything is looked up, because it is the question that decides whether
    // there is anything to look up: a wish naming neither an oracle card nor a printing is
    // a wish for nothing, and would collide with every other such row on the grain (the
    // table's own CHECK says the same thing, in the database's voice rather than the app's).
    if card_id.is_none() && sent_oracle_id.is_none() {
        return Err("a wish needs either a card or an oracle id".into());
    }
    // The folder, before anything is looked up, for [`WishInput::folder_id`]'s reason: the
    // foreign key would refuse this write anyway, in a sentence about a constraint rather than
    // about the folder, and the two other writes over this column already answer
    // [`FOLDER_GONE`]. Asked here rather than beside the finish check because it costs a query
    // — a wish that is going to be refused for naming no card should not pay for it.
    if let Some(folder) = input.folder_id {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM wishlist_folders WHERE id = ?1)",
                params![folder],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(FOLDER_GONE.to_owned());
        }
    }

    // Whatever the caller did not send, taken from the printing it named.
    let printing: Option<(Option<String>, String, String, String, String)> = match &card_id {
        Some(id) => conn
            .query_row(
                "SELECT oracle_id, name, set_code, collector_number, lang FROM cards WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        None => None,
    };
    if card_id.is_some() && printing.is_none() {
        return Err("no card with that id is in the card database".into());
    }
    // The printing's own oracle id can be blank too — `cards.oracle_id` is nullable and an
    // ingest is not a form, but a row carrying `''` would fold on the grain just the same.
    let oracle_id = sent_oracle_id.or_else(|| {
        printing
            .as_ref()
            .and_then(|p| p.0.as_deref())
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .map(str::to_owned)
    });
    let name = match sent_name.or_else(|| printing.as_ref().map(|p| p.1.clone())) {
        Some(name) => name,
        // An any-printing wish made from a card the reader is looking at sends the oracle
        // id and nothing else, so the name is read from *a* printing of that oracle card —
        // any of them, because `cards.name` is the oracle name on every printing, including
        // the translated ones (Scryfall keeps the localised one in `printed_name`). Only
        // the set, the collector number and the language stay NULL, because those are
        // properties of a printing and this wish is deliberately not for one:
        // `an_any_printing_wish_pins_nothing_but_its_name` is the fence.
        None => oracle_name(conn, oracle_id.as_deref())?,
    };

    // `folder_id` is written and never updated, and the `DO UPDATE` clause below is
    // deliberately unchanged: the folder is the fourth term of [`WISHLIST_GRAIN`], so a
    // conflict *already means* the same folder and there is nothing for a clause to decide.
    // Adding one would be the bug the grain was widened to make impossible — an add filed
    // somewhere else quietly moving the row the reader put where they wanted it.
    let sql = format!(
        "INSERT INTO wishlist_entries
            (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
             preferred_finish, notes, folder_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, unixepoch(), unixepoch())
         ON CONFLICT({WISHLIST_GRAIN}) DO UPDATE SET
            quantity = wishlist_entries.quantity + excluded.quantity,
            notes = coalesce(wishlist_entries.notes, excluded.notes),
            updated_at = unixepoch()
         RETURNING id, quantity"
    );
    let (id, quantity): (i64, i64) = conn
        .query_row(
            &sql,
            params![
                oracle_id,
                card_id,
                printing.as_ref().map(|p| p.2.clone()),
                printing.as_ref().map(|p| p.3.clone()),
                printing.as_ref().map(|p| p.4.clone()),
                name,
                quantity,
                input.preferred_finish,
                input.notes,
                input.folder_id,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// The oracle card's name, read from **any** printing of it.
///
/// `cards.name` is a fact about the *card* rather than about the printing — every printing of one
/// oracle card carries the same string — so which row this lands on cannot change the answer. The
/// `ORDER BY` is here to make the pick deterministic and for nothing else.
///
/// **It does not chase [`list_wishes`]' `LEFT JOIN`, and stopped claiming to on 2026-08-26.** That
/// join picks the **cheapest** printing at the query's marketplace, because what it chooses is the
/// card a wish is *drawn as*: its art, its set code, its rarity and its price all come off that
/// row, and a wish whose picture disagreed with its figure would be one card said two ways. A name
/// needs none of that, and matching it would mean threading a marketplace into a write to reach a
/// string that is identical either way.
fn oracle_name(conn: &Connection, oracle_id: Option<&str>) -> Result<String, String> {
    let Some(oracle_id) = oracle_id else {
        return Err("a wish needs a card name".into());
    };
    conn.query_row(
        "SELECT name FROM cards WHERE oracle_id = ?1
          ORDER BY released_at DESC, id ASC LIMIT 1",
        params![oracle_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "a wish needs a card name".to_owned())
}

/// One line of a bulk import, after TypeScript has decided everything a *wishlist* decision is.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistImportItem {
    pub oracle_id: Option<String>,
    /// `None` is a wish for **any printing** — what a wishlist usually means, and what the
    /// planner writes for a line that named no set. Not a looser version of a pinned wish:
    /// `WISHLIST_GRAIN` already treats the two as different rows.
    pub card_id: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    pub notes: Option<String>,
}

#[cfg_attr(target_family = "wasm", allow(dead_code))]
/// One transaction for the whole file — `collection::commit_import`'s rule, and its reasons.
///
/// `removed` is counted in the loop rather than derived, because a delete and an insert in one
/// file would cancel out in a before/after row count and report neither.
fn commit_import(
    conn: &Connection,
    items: &[WishlistImportItem],
    mode: &str,
) -> Result<crate::collection::ImportCommitOutcome, String> {
    if mode != "add" && mode != "set" {
        return Err(format!(
            "`{mode}` is not an import mode. Use `add` or `set`."
        ));
    }
    let before: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut removed = 0i64;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for item in items {
        let input = WishInput {
            oracle_id: item.oracle_id.clone(),
            card_id: item.card_id.clone(),
            name: None,
            quantity: item.quantity,
            preferred_finish: item.preferred_finish.clone(),
            notes: item.notes.clone(),
            // One of the three writers that add **at the root and cannot name a folder** —
            // an imported file says nothing about this reader's filing cabinet, so there is
            // nothing to say here but `None`. The consequence is written down rather than
            // discovered: a line for a card already filed in a folder lands as a *second*
            // root row, which [`WishRow::elsewhere`] is what tells the reader about.
            folder_id: None,
        };
        if mode == "add" {
            add_wish(&tx, &input)?;
            continue;
        }
        // `set`: find the row on the grain the add would have folded into, then write the
        // file's number onto it. `set_quantity` deletes at 0, which is what makes a file
        // saying `0 Sol Ring` remove that wish.
        let change = add_wish(&tx, &input)?;
        let after = set_wish_quantity(&tx, change.id, item.quantity)?;
        if after.removed {
            removed += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    let after: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let added = (after - before) + removed;
    Ok(crate::collection::ImportCommitOutcome {
        added,
        updated: items.len() as i64 - added - removed,
        removed,
    })
}

/// Set an absolute quantity. **Zero removes the row**, unlike the collection's — and a
/// negative number is refused, exactly like the collection's.
///
/// Two different asymmetries, and they pull in opposite directions on purpose.
///
/// *Zero deletes* because `wishlist_entries.quantity` carries a `CHECK (quantity > 0)`: a
/// wish holds nothing worth keeping once it is emptied — no condition, no purchase price,
/// no acquisition story, just the fact that somebody once wanted a card and now wants none
/// of it. The collection keeps its zeros because it has all of those things to keep.
///
/// *Negative is refused* for the reason [`crate::collection::set_quantity`] refuses it, and
/// the reason matters more here, not less: below zero is not a quantity at all, it can only
/// come from a bug or a hand-made payload, and in a module where zero legitimately deletes,
/// treating `-1` as "close enough to zero" would make arithmetic that went wrong somewhere
/// upstream silently destroy a row. Zero is a thing a stepper can mean; minus one is not.
/// The refusal is [`crate::collection::valid_quantity`]'s, verbatim, because "the same
/// refusal" is the claim — a second copy of the sentence is a second thing to drift.
pub fn set_wish_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String> {
    valid_quantity(quantity, "wishlist quantity")?;
    if quantity == 0 {
        return remove_wish(conn, id);
    }
    let changed = conn
        .execute(
            "UPDATE wishlist_entries SET quantity = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, quantity],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That wishlist entry is not there any more.".into());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Delete the row. Like [`crate::collection::remove_entry`], an id that resolves to nothing
/// is a success: the caller wanted that row gone, and it is gone.
pub fn remove_wish(conn: &Connection, id: i64) -> Result<EntryChange, String> {
    conn.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: 0,
        removed: true,
    })
}

/// Change which printing a wish is for — or take it back to **any printing**.
///
/// The one write that reaches `wishlist_entries.card_id` after the row exists. That column
/// has meant "any printing when NULL, that one when set" since spec §6 and schema v1, and
/// until now the only way to change a reader's mind about it was to delete the wish and make
/// a new one — which throws away the quantity, the notes and the day they wanted the card.
///
/// `Some(id)` pins: the wish's `card_id` becomes that printing and the denormalised
/// `set_code`/`collector_number`/`lang` are refreshed from `cards`, because those three
/// columns describe *a printing* and are the ones the list prints. An id `cards` does not
/// have is refused in [`add_wish`]'s words — the same sentence for the same fact, rather than
/// a second wording of it to keep in step. `None` is the way back: all four go NULL together,
/// which is the only shape "any printing" has.
///
/// **The name and the oracle id are the wish's own, and only an *absent* oracle id is filled
/// in.** `cards.name` is the oracle name on every printing, so a pin between printings of one
/// card has nothing to change; a wish that never had an oracle id (a pinned wish for a
/// printing whose `oracle_id` was NULL) adopts the new printing's, which is [`add_wish`]'s
/// `sent_oracle_id.or_else(printing)` precedence and is what lets that wish ever be unpinned.
/// Whether the two ids are printings of the *same card* is deliberately not policed here,
/// where `deck::swap_printing` does police it: that command carries a quantity onto another
/// row and would move copies onto a card nobody asked for, while this one rewrites four
/// columns of one row the reader is looking at, and the pane offers them only that card's own
/// printings. The worst a mispaired call does is describe a wish as the wrong cardboard,
/// visibly, and repointing it again is the cure.
///
/// A wish whose `oracle_id` is NULL cannot be unpinned at all, and that is the table's
/// `CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)` **said in the app's voice before
/// the database says it in its own**: the printing is genuinely all that wish has, and
/// clearing it would leave a row for nothing.
///
/// # The merge, and why it is not a refusal
///
/// The rule `wishlist_folders::set_wish_folder` follows too, written once here: **a write
/// that lands on a taken grain merges, it does not fail.** Un-pinning a wish for the Alpha
/// Bolt while an any-printing Bolt wish already sits in the same folder violates
/// `idx_wishlist_grain` — but what the reader just said is that those are one wish, and a
/// `UNIQUE constraint failed` reaching them would be the app telling them off for agreeing
/// with it. So the two quantities sum into the row that was already there, the source row is
/// deleted, and the answer names the **destination**: three Alpha Bolts un-pinned onto two
/// open Bolt wishes is one wish for five copies. Notes are kept the way [`add_wish`]'s own
/// `ON CONFLICT` keeps them — the survivor's, falling back to the folded row's — and the
/// survivor's `needs_review` is left alone, `reconcile`'s fold rule: that sentence is about
/// the row that is staying, and this press was not about it.
///
/// `removed` stays `false` on that path even though a row was deleted. The field means "the
/// wish is gone", which is what [`remove_wish`] and a zero quantity mean, and here the wish
/// is emphatically still on the list — the caller re-reads and selects the id it was handed.
///
/// # The rest
///
/// `needs_review` is **cleared** on the ordinary path, because choosing a printing *is* the
/// review. The only sentences that column carries are the reconciler's, and both are about an
/// id — "Scryfall merged this printing into …", "Scryfall removed this printing …" — that the
/// row no longer holds once this write lands. `deck::swap_printing` does not carry the flag
/// across for the same reason.
///
/// One transaction, for the reason every fold in this crate is one: mid-merge the copies are
/// in both rows or in neither.
pub fn set_wish_printing(
    conn: &Connection,
    id: i64,
    card_id: Option<String>,
) -> Result<EntryChange, String> {
    // [`add_wish`]'s rule about what a form's cleared field means, and it decides the whole
    // shape of the write here: `Some("")` is a caller sending an empty text input, not a
    // printing, and treating it as one would pin the wish to an id no card has.
    let card_id = crate::filters::nonblank(&card_id).map(str::to_owned);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The three grain terms this write does *not* touch, plus the quantity the merge moves.
    // Read before anything is decided, because "is that wish still there?" is answered by the
    // same statement — an `UPDATE` that changed no rows cannot tell a missing row apart from
    // a grain collision, and the two want opposite answers.
    let (oracle_id, preferred_finish, folder_id, quantity): (
        Option<String>,
        Option<String>,
        Option<i64>,
        i64,
    ) = tx
        .query_row(
            "SELECT oracle_id, preferred_finish, folder_id, quantity
               FROM wishlist_entries WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That wishlist entry is not there any more.".to_owned())?;

    let printing: Option<(Option<String>, String, String, String)> = match &card_id {
        Some(cid) => tx
            .query_row(
                "SELECT oracle_id, set_code, collector_number, lang FROM cards WHERE id = ?1",
                params![cid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        None => None,
    };
    if card_id.is_some() && printing.is_none() {
        return Err("no card with that id is in the card database".into());
    }
    if card_id.is_none() && oracle_id.is_none() {
        return Err(
            "This wish is for that one printing and names no card, so there is no \
                    card to want any printing of. Remove it and wish for the card instead."
                .into(),
        );
    }
    // [`add_wish`]'s fallback, verbatim: an oracle id the wish already has is not up for
    // revision, and the printing's own can be blank, which would fold on the grain like any
    // other empty string.
    let oracle_id = oracle_id.or_else(|| {
        printing
            .as_ref()
            .and_then(|p| p.0.as_deref())
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .map(str::to_owned)
    });

    // The grain the write is *about to land on*, spelled out rather than interpolated from
    // [`WISHLIST_GRAIN`] for the reason `reconcile::collision_target` gives: that constant is
    // a list of expressions over **one row**, and this compares the same list against four
    // bound values. Every term is here — a fold that matched on three of the four would merge
    // a wish into a row in another folder, which is exactly the bug the fourth term exists to
    // make impossible.
    let target: Option<(i64, i64)> = tx
        .query_row(
            "SELECT id, quantity FROM wishlist_entries
              WHERE id <> ?1
                AND coalesce(oracle_id,'') = coalesce(?2,'')
                AND coalesce(card_id,'') = coalesce(?3,'')
                AND coalesce(preferred_finish,'') = coalesce(?4,'')
                AND coalesce(folder_id,0) = coalesce(?5,0)",
            params![id, oracle_id, card_id, preferred_finish, folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((target, held)) = target {
        tx.execute(
            "UPDATE wishlist_entries SET
                quantity = quantity + ?2,
                notes = coalesce(notes, (SELECT notes FROM wishlist_entries WHERE id = ?3)),
                updated_at = unixepoch()
              WHERE id = ?1",
            params![target, quantity, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(EntryChange {
            id: target,
            quantity: held + quantity,
            removed: false,
        });
    }

    // All four printing columns move together, and NULL is a value here rather than an
    // omission: `coalesce(?n, column)` — the convention `DeckPatch` uses for "leave it" —
    // would make un-pinning unexpressible, which is half of what this command is for.
    let (set_code, collector_number, lang) = match &printing {
        Some(p) => (Some(p.1.clone()), Some(p.2.clone()), Some(p.3.clone())),
        None => (None, None, None),
    };
    tx.execute(
        "UPDATE wishlist_entries SET
            card_id = ?2, oracle_id = ?3, set_code = ?4, collector_number = ?5, lang = ?6,
            needs_review = NULL, updated_at = unixepoch()
          WHERE id = ?1",
        params![id, card_id, oracle_id, set_code, collector_number, lang],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

pub fn list_wishes(conn: &Connection, q: &WishlistQuery) -> Result<WishlistPage, String> {
    let limit = if q.limit == 0 {
        DEFAULT_LIMIT
    } else {
        q.limit.min(MAX_LIMIT)
    };
    let mut p = crate::filters::Predicates::default();
    // What one copy of this wish costs, built once and used twice: to *choose* the printing an
    // any-printing wish is drawn as, and to price whichever printing that turns out to be. One
    // expression rather than two, so the picture and the figure under it can never come from two
    // different rules.
    let price = crate::sorting::row_price_expr(q.marketplace, WISH_PREFERRED_FINISH);
    // The card a wish is *about*: its pinned printing, or the **cheapest** printing of its oracle
    // card at the marketplace this query named. A LEFT JOIN, because a wish outlives the printing
    // it was made from.
    //
    // **`ORDER BY … ASC NULLS LAST` with the old clause as the tiebreak**, which is what makes
    // this safe for the wishes it cannot answer: an oracle card no marketplace quotes keeps the
    // newest printing it has always had, so a wish never loses its art or its set code to a hole
    // in a pricelist.
    //
    // **The inner alias is `c` and it shadows the outer one deliberately.**
    // `crate::sorting::price_expr` hard-codes `c` for the printing being priced — that is what
    // keeps the join key and the price from being spelled apart across six call sites — so the
    // candidate printing inside this subquery has to wear that name. The `w.` references stay
    // correlated to the outer wish, which is the whole reason this is a subquery rather than a
    // join.
    //
    // **`coalesce` short-circuits, so this runs only for an unpinned wish.** A page is at most
    // `MAX_LIMIT` rows and this database has 0 unpinned wishes of 88; the cost is bounded by how
    // many wishes name no printing, not by the size of the corpus.
    let from = format!(
        "wishlist_entries w LEFT JOIN cards c
             ON c.id = coalesce(w.card_id,
                 (SELECT c.id FROM cards c
                   WHERE c.oracle_id = w.oracle_id
                   ORDER BY ({price}) ASC NULLS LAST, c.released_at DESC, c.id ASC
                   LIMIT 1))"
    );
    let cards = crate::filters::CardFilters {
        text: None,
        paper_only: Some(false),
        ..q.cards.clone()
    };
    // `Some("w")`, for the reason the collection passes `Some("e")`: a pinned wish copies
    // its printing onto the row at write time and the list *shows* that set code, so a wish
    // displayed as `lea` must not vanish when the reader filters to `lea` merely because
    // `cards` no longer knows the printing. (An unpinned wish has no set of its own and is
    // matched through the printing the join picked for it, which is a printing rather than
    // *the* printing — a set filter over an any-printing wish is a loose question and gets
    // a loose answer.)
    crate::filters::push_card_filters(&mut p, &cards, "c", Some("w"));
    if let Some(text) = crate::filters::nonblank(&q.cards.text) {
        // Matched against the stored name rather than through FTS: a wish carries its own
        // name (it may have no card row at all), and a list of a few hundred rows does not
        // need an index to filter by one.
        //
        // `ESCAPE`, because `LIKE`'s own wildcards are ordinary characters in a search box:
        // a reader who types `%` means the per-cent sign, not "everything", and `_` is one
        // keystroke away from `-` on a name like `God-Pharaoh`. Unescaped, either turns a
        // filter into a filter that does not filter — which is the failure nobody reports,
        // because a list that shows too much still looks like a list.
        p.push(
            format!("w.name LIKE '%' || ? || '%' ESCAPE '{LIKE_ESCAPE}'"),
            Box::new(escape_like(text)),
        );
    }
    // Named once for the whole statement build: the filter below and the `owned_quantity`
    // column further down have to be the same expression, or a list could hide a row whose
    // own badge says it is still short.
    let owned = OWNED_SQL;
    match q.fulfilled {
        Some(true) => p.wheres.push(format!("{owned} >= w.quantity")),
        Some(false) => p.wheres.push(format!("{owned} < w.quantity")),
        None => {}
    }
    // [`crate::collection::scope`]'s three-way match, over this table's column. Pushed
    // before the count is taken, so the header cannot count rows the list will not show.
    match q.needs_review {
        Some(true) => p.wheres.push("w.needs_review IS NOT NULL".to_owned()),
        Some(false) => p.wheres.push("w.needs_review IS NULL".to_owned()),
        None => {}
    }
    // Where the reader is standing. Flattened, they are standing everywhere and no term is
    // pushed at all — which is not the same as `folder_id IS NULL`, and is the whole reason
    // [`WishlistQuery::flatten`] exists as a second field.
    //
    // **`IS`, never `=`.** The root is `folder_id IS NULL` and `= NULL` is not false but
    // *unknown*, so an `=` here would answer the empty list for the one folder most wishes
    // are in — a list that shows nothing, with no error and nothing in `error_log`. SQLite's
    // `IS` compares NULLs as equal and is the same device [`WISHLIST_GRAIN`]'s `coalesce`es
    // are, one operator instead of one wrapper per side.
    if !q.flatten {
        p.push("w.folder_id IS ?".to_owned(), Box::new(q.folder_id));
    }
    let where_sql = p.where_sql();
    let mut params = p.params;

    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {from} WHERE {where_sql}"),
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let order = crate::sorting::order_by(
        q.sort.as_deref(),
        &crate::sorting::sorts_for(WISHLIST_SORTS, WISHLIST_PRICE_SORTS, UNIT_PRICE_ALIAS),
        "w.name ASC",
        "w.id ASC",
    );
    let sql = format!(
        "SELECT w.id, w.oracle_id, w.card_id, w.name, w.set_code, w.collector_number, w.lang,
                c.rarity, c.mana_cost, w.quantity, w.preferred_finish,
                {price} AS {UNIT_PRICE_ALIAS},
                {owned} AS owned_quantity,
                w.notes, w.needs_review, w.updated_at,
                -- Appended rather than placed beside `c.mana_cost` where it belongs in the
                -- struct: every `r.get(n)` below is a positional index, so inserting a column
                -- mid-list renumbers eight of them by hand. Last costs one index and nothing
                -- else. `c.id` and `c.legalities` arrived the same way and for the same
                -- reason, and so do the two below them.
                c.type_line, c.id, c.legalities,
                -- The other wishes for this same oracle card. Over the whole table on
                -- purpose: the answer the row needs is about wishes this page did not fetch
                -- and this folder does not hold.
                --
                -- `o.oracle_id IS NOT NULL` is load-bearing and is the fence rather than the
                -- arithmetic. Two orphans with no oracle id must not count each other, and
                -- `NULL = NULL` is *unknown* rather than true, so today the comparison
                -- already refuses them — but the tempting rewrite of this line is a pair of
                -- `coalesce(…, '')`s to match [`WISHLIST_GRAIN`]'s first term, and that
                -- version would put every orphan on `''` and have them all count each other.
                -- `elsewhere_counts_the_other_wishes_for_the_same_oracle_card` is what fails
                -- if anyone writes it.
                (SELECT count(*) FROM wishlist_entries o
                  WHERE o.id <> w.id AND o.oracle_id IS NOT NULL
                    AND o.oracle_id = w.oracle_id) AS elsewhere,
                w.folder_id
         FROM {from} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    params.push(Box::new(limit));
    params.push(Box::new(q.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| {
                Ok(WishRow {
                    id: r.get(0)?,
                    oracle_id: r.get(1)?,
                    card_id: r.get(2)?,
                    name: r.get(3)?,
                    set_code: r.get(4)?,
                    collector_number: r.get(5)?,
                    lang: r.get(6)?,
                    rarity: r.get(7)?,
                    mana_cost: r.get(8)?,
                    type_line: r.get(16)?,
                    art_card_id: r.get(17)?,
                    quantity: r.get(9)?,
                    preferred_finish: r.get(10)?,
                    unit_price: r.get(11)?,
                    owned_quantity: r.get(12)?,
                    notes: r.get(13)?,
                    needs_review: r.get(14)?,
                    updated_at: r.get(15)?,
                    legalities: r.get(18)?,
                    elsewhere: r.get(19)?,
                    folder_id: r.get(20)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(WishlistPage { items, total })
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_add(
    state: tauri::State<'_, Arc<AppState>>,
    wish: WishInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| add_wish(c, &wish)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_quantity(c, id, quantity))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| remove_wish(c, id)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// "Use this printing", and "Any printing" — see [`set_wish_printing`] for the merge, which
/// is why this answers an [`EntryChange`] whose `id` is not always the `id` it was given.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_set_printing(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    card_id: Option<String>,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_printing(c, id, card_id))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// One transaction for a whole imported file — see [`commit_import`] for the `set` arm's route
/// through [`add_wish`] and why `removed` is counted rather than derived.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<WishlistImportItem>,
    mode: String,
) -> Result<crate::collection::ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| commit_import(c, &items, &mode))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// The wishlist. **Read-only** connection, blocking pool — as every read in this app is.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
) -> Result<WishlistPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_wishes(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sorting::Marketplace;

    /// One sort term, in the shape the UI sends.
    fn term(key: &str, dir: &str) -> crate::sorting::SortTerm {
        crate::sorting::SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        for (id, set, cn) in [("bolt-lea", "lea", "161"), ("bolt-2ed", "2ed", "162")] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,raw)
                 VALUES (?1,'o1','Lightning Bolt',?2,?3,'en','normal',
                    '{\"usd\":\"5.00\",\"usd_foil\":\"40.00\",\"eur\":\"4.00\",\"eur_foil\":\"32.00\"}',
                    '{}')",
                rusqlite::params![id, set, cn],
            )
            .unwrap();
        }
        // A generic printing for `commit_import`'s tests, whose oracle id (`oracle-1`) is what
        // the wishlist import lines name directly.
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                prices,raw)
             VALUES ('card-1','oracle-1','Test Card','tst','1','en','normal',
                '{\"usd\":\"1.00\"}','{}')",
            [],
        )
        .unwrap();
        conn
    }

    /// An empty database at the current schema — no cards, no wishes.
    ///
    /// [`seeded`]'s two bolts share one oracle card and one price blob, which is exactly what
    /// the price fixtures below must not have: each of them seeds the printings its own
    /// question is about.
    fn empty() -> Connection {
        crate::schema::memory_pair()
    }

    /// One printing, with its own `finishes` list and its own price blob.
    ///
    /// Its oracle id is its own id, so a card seeded this way is the only printing of itself —
    /// which is what the tests about *which finish* is priced want, and the opposite of what
    /// [`seed_printing`] is for.
    fn seed_card_with_prices(conn: &Connection, id: &str, finishes: &str, prices: &str) {
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                finishes,prices,raw)
             VALUES (?1,?1,?1,'tst','1','en','normal',?2,?3,'{}')",
            rusqlite::params![id, finishes, prices],
        )
        .unwrap();
    }

    /// One printing **of a shared oracle card**, with its own release date and price blob.
    ///
    /// [`seed_card_with_prices`]'s opposite number: that one makes a card that is the only
    /// printing of itself, this one makes several printings the join has to choose between.
    fn seed_printing(
        conn: &Connection,
        id: &str,
        oracle_id: &str,
        released_at: &str,
        prices: &str,
    ) {
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                released_at,prices,raw)
             VALUES (?1,?2,?2,'tst',?1,'en','normal',?3,?4,'{}')",
            rusqlite::params![id, oracle_id, released_at, prices],
        )
        .unwrap();
    }

    /// A wish for the oracle card and no printing — the "any printing" half of the table's
    /// nullable `card_id`, which is the half the join below has to answer for.
    fn add_any_printing_wish(conn: &Connection, oracle_id: &str, finish: Option<&str>) -> i64 {
        add_wish(
            conn,
            &WishInput {
                oracle_id: Some(oracle_id.to_owned()),
                preferred_finish: finish.map(str::to_owned),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// A wish pinned to one printing, at an optional finish.
    ///
    /// [`add_wish`] is the real command and takes a whole [`WishInput`]; this is that call with
    /// everything these tests do not ask about defaulted away. It is not *named* `add_wish`
    /// because that name is the command's and shadowing it here would rewrite two dozen
    /// neighbouring tests.
    fn add_pinned_wish(conn: &Connection, card_id: &str, finish: Option<&str>) -> i64 {
        add_wish(
            conn,
            &WishInput {
                card_id: Some(card_id.to_owned()),
                preferred_finish: finish.map(str::to_owned),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The page's default query at one marketplace. The price tests are about the money and
    /// about nothing else the query can say.
    fn query_at(marketplace: Marketplace) -> WishlistQuery {
        WishlistQuery {
            marketplace,
            ..Default::default()
        }
    }

    /// A wishlist folder, written straight into the table: the commands that make one are
    /// `wishlist_folders`', and this module's tests need nothing from them but somewhere to
    /// file a wish. `id` is given rather than returned so the fixtures below can name the
    /// folders they build in the order they read.
    fn folder(conn: &Connection, id: i64, parent: Option<i64>, name: &str) {
        conn.execute(
            "INSERT INTO wishlist_folders
                (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, unixepoch(), unixepoch())",
            params![id, parent, name],
        )
        .unwrap();
    }

    /// One wish for one card in three places — the root, `Ordered`, and `Ordered/Someday`.
    ///
    /// A shape only schema v23 allows: before the folder joined [`WISHLIST_GRAIN`] these
    /// three adds were one row with a quantity of three. It is what all three folder views
    /// are asked about below, and the ids come back because the rows are otherwise identical.
    fn filed_three_ways() -> (Connection, i64, i64, i64) {
        let conn = seeded();
        folder(&conn, 1, None, "Ordered");
        folder(&conn, 2, Some(1), "Someday");
        let at = |folder_id: Option<i64>| {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("o1".into()),
                    quantity: 1,
                    folder_id,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };
        let (root, ordered, someday) = (at(None), at(Some(1)), at(Some(2)));
        (conn, root, ordered, someday)
    }

    /// One any-printing line of a bulk import, in the shape [`commit_import`]'s tests use it.
    fn wish(oracle_id: &str, quantity: i64) -> WishlistImportItem {
        WishlistImportItem {
            oracle_id: Some(oracle_id.to_owned()),
            card_id: None,
            quantity,
            preferred_finish: None,
            notes: None,
        }
    }

    /// A wish pinned to one printing.
    fn pinned_wish(oracle_id: &str, card_id: &str, quantity: i64) -> WishlistImportItem {
        WishlistImportItem {
            card_id: Some(card_id.to_owned()),
            ..wish(oracle_id, quantity)
        }
    }

    /// A finish no `CHECK` will take — the refusal that has to roll a whole file back.
    fn bad_finish_wish(oracle_id: &str, quantity: i64) -> WishlistImportItem {
        WishlistImportItem {
            preferred_finish: Some("glitter".into()),
            ..wish(oracle_id, quantity)
        }
    }

    fn quantity_of(conn: &Connection, oracle_id: &str) -> i64 {
        conn.query_row(
            "SELECT quantity FROM wishlist_entries WHERE oracle_id = ?1 AND card_id IS NULL",
            params![oracle_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn wish_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap()
    }

    /// The distinction spec §6 draws in one word: `card_id` NULL is "any printing", set is
    /// "that one". Both are real wishes and neither replaces the other.
    #[test]
    fn a_wish_can_be_for_any_printing_or_for_one_printing() {
        let conn = seeded();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        let specific = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(any.id, specific.id);

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        assert_eq!(rows.total, 2);
        let any_row = rows.items.iter().find(|r| r.id == any.id).unwrap();
        assert_eq!(any_row.card_id, None);
        assert_eq!(
            any_row.name, "Lightning Bolt",
            "named from the printing it was made from"
        );
        let one = rows.items.iter().find(|r| r.id == specific.id).unwrap();
        assert_eq!(one.set_code.as_deref(), Some("lea"));
    }

    /// `art_card_id` answers "what is there a picture of", which is a different question from
    /// "what is this wish for" — and the wall needs both, because it draws one and says the
    /// other.
    #[test]
    fn art_card_id_is_the_printing_a_wish_is_drawn_as() {
        let conn = seeded();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let any_row = rows.items.iter().find(|r| r.id == any.id).unwrap();
        // Pinned to nothing, and still drawable: the join reaches a printing of the oracle
        // card, which is `bolt-2ed` here. **The expectation is unchanged by the move to the
        // cheapest printing** — `seeded` gives both bolts the same blob, so the price term is a
        // tie, `released_at` is NULL on both, and the order falls all the way to its last
        // tiebreak, `id ASC`. Which printing is *cheapest* is
        // `an_any_printing_wish_takes_the_cheapest_printing`'s question, over a fixture whose
        // printings disagree about money.
        assert_eq!(any_row.card_id, None);
        assert_eq!(any_row.art_card_id.as_deref(), Some("bolt-2ed"));

        let pinned_row = rows.items.iter().find(|r| r.id == pinned.id).unwrap();
        assert_eq!(pinned_row.art_card_id.as_deref(), Some("bolt-lea"));

        // The orphan: the printing leaves `cards` and the wish outlives it. The other printing
        // of the same oracle card is *not* substituted — `coalesce` takes the pinned id, which
        // now matches nothing — so the wall draws the no-art frame rather than a picture of a
        // card this wish was never for.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();
        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let orphan = rows.items.iter().find(|r| r.id == pinned.id).unwrap();
        assert_eq!(orphan.card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(orphan.art_card_id, None);
        assert_eq!(orphan.name, "Lightning Bolt", "the wish still names itself");
    }

    /// An **any-printing** wish is for the card, so it is drawn as — and priced at — the cheapest
    /// printing the marketplace quotes, not the newest one released.
    ///
    /// The printing travels with the price on purpose: `art_card_id` comes off this same join, so
    /// the picture, the rarity gem and the chin's set and number all name the printing the figure
    /// beside them is about. A tile drawn as one printing and priced at another would be the one
    /// kind of wrong a reader cannot check.
    #[test]
    fn an_any_printing_wish_takes_the_cheapest_printing() {
        let conn = empty();
        // Same oracle card, three printings. The newest is the dearest, which is what makes this
        // test able to fail: under the old `released_at DESC` it is the one that was chosen.
        seed_printing(
            &conn,
            "bolt-new",
            "oracle-bolt",
            "2025-01-01",
            r#"{"usd": "40.00"}"#,
        );
        seed_printing(
            &conn,
            "bolt-mid",
            "oracle-bolt",
            "2015-01-01",
            r#"{"usd": "2.00"}"#,
        );
        seed_printing(
            &conn,
            "bolt-old",
            "oracle-bolt",
            "1993-01-01",
            r#"{"usd": "9.00"}"#,
        );
        add_any_printing_wish(&conn, "oracle-bolt", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(
            page.items[0].unit_price,
            Some(2.00),
            "the cheapest, not the newest"
        );
        assert_eq!(
            page.items[0].art_card_id.as_deref(),
            Some("bolt-mid"),
            "and the tile is drawn as that same printing"
        );
    }

    /// An oracle card **no marketplace quotes** keeps the newest printing.
    ///
    /// A wish still needs art and still needs a set code, so ordering unpriced rows last with the
    /// old clause as the tiebreak makes this change a no-op for exactly the wishes it could
    /// otherwise have left blank.
    #[test]
    fn an_unpriced_oracle_card_keeps_the_newest_printing() {
        let conn = empty();
        seed_printing(
            &conn,
            "obscure-new",
            "oracle-obscure",
            "2025-01-01",
            r#"{}"#,
        );
        seed_printing(
            &conn,
            "obscure-old",
            "oracle-obscure",
            "1999-01-01",
            r#"{}"#,
        );
        add_any_printing_wish(&conn, "oracle-obscure", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(page.items[0].unit_price, None);
        assert_eq!(page.items[0].art_card_id.as_deref(), Some("obscure-new"));
    }

    /// **An unquoted printing never outranks a quoted one** — which is what `NULLS LAST` says,
    /// and it is the one term of that ORDER BY SQLite's default disagrees with: ascending, a NULL
    /// sorts *first*. Without it, every oracle card holding one printing the marketplace has
    /// never listed would be drawn as that printing and priced at nothing.
    ///
    /// `an_unpriced_oracle_card_keeps_the_newest_printing` above cannot say this and it is worth
    /// saying why: both of its printings are unquoted, so NULLs-first and NULLs-last pick the
    /// same row and the clause is unfalsifiable there. Dropping `NULLS LAST` leaves that test
    /// green — measured on 2026-08-26 — and this one red. A fixture has to *mix* the two, which
    /// is the state the corpus is in: a marketplace quotes some printings and not others.
    #[test]
    fn an_unquoted_printing_never_outranks_a_quoted_one() {
        let conn = empty();
        seed_printing(&conn, "mix-new", "oracle-mix", "2025-01-01", r#"{}"#);
        seed_printing(
            &conn,
            "mix-old",
            "oracle-mix",
            "2015-01-01",
            r#"{"usd": "5.00"}"#,
        );
        add_any_printing_wish(&conn, "oracle-mix", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(page.items[0].unit_price, Some(5.00));
        assert_eq!(
            page.items[0].art_card_id.as_deref(),
            Some("mix-old"),
            "the printing the marketplace quotes, not the newer one it does not"
        );
    }

    /// A **pinned** wish is untouched: `coalesce` short-circuits, so the subquery never runs for
    /// one, and the printing the reader chose is the printing they keep however cheap another is.
    #[test]
    fn a_pinned_wish_keeps_its_own_printing_however_dear() {
        let conn = empty();
        seed_printing(
            &conn,
            "bolt-new",
            "oracle-bolt",
            "2025-01-01",
            r#"{"usd": "40.00"}"#,
        );
        seed_printing(
            &conn,
            "bolt-mid",
            "oracle-bolt",
            "2015-01-01",
            r#"{"usd": "2.00"}"#,
        );
        add_pinned_wish(&conn, "bolt-new", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(page.items[0].art_card_id.as_deref(), Some("bolt-new"));
        assert_eq!(page.items[0].unit_price, Some(40.00));
    }

    /// **A wish row carries the joined printing's `legalities`, at the index the appended
    /// column put it at.**
    ///
    /// Issue #192: the Arena export offers to leave out cards that are not in MTG Arena, and
    /// this blob is the only fact that answers it. The verdict is TypeScript's
    /// (`src/features/transfer/export/arena.ts`, which reads Scryfall's key *names*); this test
    /// is about the column arriving, and arriving at the right index — it is the third
    /// appended one, after `c.type_line` and `c.id`.
    ///
    /// **An any-printing wish carries one too**, which is the half worth pinning: the join
    /// coalesces to a printing of the oracle card, exactly as it does for `type_line` and
    /// `art_card_id`, so only a genuine orphan answers `None` — and an Arena export of the
    /// wishlist would otherwise leave out every unpinned wish on it.
    #[test]
    fn a_wish_row_carries_the_joined_printings_legalities() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET legalities = '{\"timeless\":\"legal\"}' WHERE id = 'bolt-2ed'",
            [],
        )
        .unwrap();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let of = |id: i64| rows.items.iter().find(|r| r.id == id).unwrap();
        // The unpinned wish resolves to `bolt-2ed`, the printing `art_card_id` above draws.
        assert_eq!(
            of(any.id).legalities.as_deref(),
            Some(r#"{"timeless":"legal"}"#)
        );
        // The neighbour an insertion would have displaced, and a printing with no blob.
        assert_eq!(of(any.id).art_card_id.as_deref(), Some("bolt-2ed"));
        assert_eq!(of(pinned.id).legalities, None);
    }

    /// An any-printing wish is not for a printing, so it must not quietly claim one: the
    /// set, the collector number and the language stay NULL even though a name was read
    /// from a printing to make the row sayable.
    #[test]
    fn an_any_printing_wish_pins_nothing_but_its_name() {
        let conn = seeded();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let row = &list_wishes(&conn, &WishlistQuery::default()).unwrap().items[0];
        assert_eq!(row.name, "Lightning Bolt");
        assert_eq!(
            (
                row.card_id.as_deref(),
                row.set_code.as_deref(),
                row.collector_number.as_deref(),
                row.lang.as_deref()
            ),
            (None, None, None, None)
        );

        // And an oracle id with no printing left in `cards` still makes a wish — but only
        // with a name the caller supplies, because there is nowhere to read one from.
        let nameless = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-vanished".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(nameless.contains("needs a card name"), "{nameless}");
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-vanished".into()),
                name: Some("Ancestral Recall".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// Wishing for the same thing twice raises the number rather than making a second
    /// line on the shopping list.
    #[test]
    fn wishing_twice_for_the_same_thing_raises_the_quantity() {
        let conn = seeded();
        let first = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let second = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 3,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((first.id, second.quantity), (second.id, 4));
    }

    /// The grain, in the language a user would use for it: the same card wished for in a
    /// different finish, or pinned to a printing, is a different line on the list. Task 4
    /// proved the index; this is the statement that reaches it.
    #[test]
    fn a_different_finish_or_printing_is_a_different_wish() {
        let conn = seeded();
        let wish = |finish: Option<&str>, card: Option<&str>| {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("o1".into()),
                    card_id: card.map(str::to_owned),
                    preferred_finish: finish.map(str::to_owned),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };

        let mut ids = vec![
            wish(None, None),
            wish(Some("foil"), None),
            wish(Some("etched"), None),
            wish(None, Some("bolt-lea")),
            wish(Some("foil"), Some("bolt-lea")),
            wish(None, Some("bolt-2ed")),
        ];
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 6, "six wishes, six rows");
    }

    /// The enum, refused in words rather than as the table's CHECK — which names
    /// `preferred_finish IN (…)` and no way forward.
    #[test]
    fn an_unknown_preferred_finish_is_refused_with_a_sentence() {
        let conn = seeded();
        let err = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                preferred_finish: Some("Foil".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("nonfoil"), "{err}");
        assert!(!err.contains("CHECK"), "{err}");
    }

    /// "Owned badges appear in search once a wish is fulfilled" (spec §7) needs the count
    /// of what is owned *against the wish*: any printing counts copies of the oracle card,
    /// a pinned wish counts copies of that printing only.
    #[test]
    fn a_wish_reports_how_much_of_it_is_already_owned() {
        let conn = seeded();
        crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-2ed".into(),
                finish: "nonfoil".into(),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let owned_of = |id: i64| {
            rows.items
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .owned_quantity
        };
        assert_eq!(owned_of(any.id), 2, "any Lightning Bolt counts");
        assert_eq!(owned_of(pinned.id), 0, "the Alpha one is not owned");
    }

    /// "What is still missing" is the question a shopping list is usually asked, and the
    /// answer has to move as the collection does — including through a row emptied to
    /// zero, which the collection keeps and which owns no copies.
    #[test]
    fn the_fulfilled_filter_splits_the_list_by_what_is_already_held() {
        let conn = seeded();
        let held = crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-2ed".into(),
                finish: "nonfoil".into(),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let covered = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let missing = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let only = |fulfilled: bool| {
            let page = list_wishes(
                &conn,
                &WishlistQuery {
                    fulfilled: Some(fulfilled),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                page.total,
                page.items.len() as i64,
                "count agrees with page"
            );
            page.items.iter().map(|r| r.id).collect::<Vec<_>>()
        };
        assert_eq!(only(true), vec![covered.id]);
        assert_eq!(only(false), vec![missing.id]);

        // Trading the copies away un-fulfils the wish: the collection keeps the row at
        // zero, and zero copies satisfy nothing.
        crate::collection::set_quantity(&conn, held.id, 0).unwrap();
        assert_eq!(only(true), Vec::<i64>::new());
        assert_eq!(only(false).len(), 2);
    }

    /// The finish is the third term of the grain, so it has to be the third term of
    /// "already owned" as well. A wish *for the foil* is not satisfied by the nonfoil in a
    /// binder — and if it were, the wish would silently leave the "still missing" list the
    /// day its cheap sibling arrived, which is the one moment a shopping list must not
    /// lose an entry.
    #[test]
    fn a_wish_for_one_finish_is_not_filled_by_another() {
        let conn = seeded();
        crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-lea".into(),
                finish: "nonfoil".into(),
                quantity: 3,
                ..Default::default()
            },
        )
        .unwrap();
        let wish = |card: Option<&str>, oracle: Option<&str>, finish: Option<&str>| {
            add_wish(
                &conn,
                &WishInput {
                    card_id: card.map(str::to_owned),
                    oracle_id: oracle.map(str::to_owned),
                    preferred_finish: finish.map(str::to_owned),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };
        let foil = wish(Some("bolt-lea"), None, Some("foil"));
        let any_finish = wish(Some("bolt-lea"), None, None);
        // The same distinction through the oracle card rather than the printing.
        let foil_any_printing = wish(None, Some("o1"), Some("foil"));

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let owned_of = |id: i64| {
            rows.items
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .owned_quantity
        };
        assert_eq!(owned_of(foil), 0, "three nonfoils fill no foil wish");
        assert_eq!(owned_of(foil_any_printing), 0, "nor at any printing");
        assert_eq!(
            owned_of(any_finish),
            3,
            "a wish with no preference takes it"
        );

        // And the "still missing" list has to agree, in both directions.
        let missing: Vec<i64> = list_wishes(
            &conn,
            &WishlistQuery {
                fulfilled: Some(false),
                ..Default::default()
            },
        )
        .unwrap()
        .items
        .iter()
        .map(|r| r.id)
        .collect();
        assert!(missing.contains(&foil), "the foil wish is still missing");
        assert!(missing.contains(&foil_any_printing));
        assert!(!missing.contains(&any_finish));

        // A foil actually arriving is what fills it — and fills only it.
        crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-lea".into(),
                finish: "foil".into(),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let owned_of = |id: i64| {
            rows.items
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .owned_quantity
        };
        assert_eq!(owned_of(foil), 1);
        assert_eq!(owned_of(foil_any_printing), 1);
        assert_eq!(
            owned_of(any_finish),
            4,
            "no preference counts both finishes"
        );
    }

    /// A wish is removed, never emptied: `quantity > 0` is the table's own CHECK, which is
    /// the asymmetry with the collection's zero-keeps-the-row rule.
    #[test]
    fn taking_a_wish_to_zero_removes_it() {
        let conn = seeded();
        let wish = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 3,
                ..Default::default()
            },
        )
        .unwrap();

        let lowered = set_wish_quantity(&conn, wish.id, 1).unwrap();
        assert_eq!((lowered.quantity, lowered.removed), (1, false));

        let emptied = set_wish_quantity(&conn, wish.id, 0).unwrap();
        assert!(emptied.removed, "zero is a removal, not a state");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);

        // A stale id from a list that has not refreshed: an *adjustment* could not do what
        // it was asked, but a delete that finds nothing already has what it wanted.
        let err = set_wish_quantity(&conn, wish.id, 2).unwrap_err();
        assert!(err.contains("not there any more"), "{err}");
        assert!(remove_wish(&conn, wish.id).unwrap().removed);
    }

    /// Zero is a thing a stepper can mean; minus one is not. In a module where zero
    /// legitimately deletes, letting a negative through would make arithmetic that went
    /// wrong upstream destroy a row — so the wishlist refuses below zero in the same words
    /// the collection does, and the row is still there afterwards to prove it.
    #[test]
    fn a_negative_quantity_is_refused_and_never_deletes_a_wish() {
        let conn = seeded();
        let wish = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();

        let err = set_wish_quantity(&conn, wish.id, -1).unwrap_err();
        assert!(err.contains("not a quantity"), "{err}");
        assert!(!err.contains("CHECK"), "{err}");

        let (rows, qty): (i64, i64) = conn
            .query_row("SELECT count(*), quantity FROM wishlist_entries", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((rows, qty), (1, 2), "a refused write changes nothing");
    }

    /// A blank id is not an id. `CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)` is
    /// satisfied by `''`, and [`WISHLIST_GRAIN`] coalesces NULL to `''` — so an empty
    /// `oracleId` from a cleared form field would land on the grain `('','','')` and fold
    /// every other such wish into one row, silently adding up unrelated cards' quantities.
    #[test]
    fn a_blank_id_is_no_id_at_all_and_never_folds_two_cards_into_one_row() {
        let conn = seeded();
        let blank = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("   ".into()),
                card_id: Some("".into()),
                name: Some("Lightning Bolt".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(blank.contains("either a card or an oracle id"), "{blank}");

        // The near miss the guard is really for: one blank id and one real name each, twice
        // over. Refused, so they cannot become one row.
        for name in ["Black Lotus", "Ancestral Recall"] {
            let err = add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("".into()),
                    name: Some(name.to_owned()),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap_err();
            assert!(err.contains("either a card or an oracle id"), "{err}");
        }
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);

        // Whitespace around a real id is trimmed rather than stored, so the padded form of
        // a wish is the same wish and not a second row beside it.
        let padded = add_wish(
            &conn,
            &WishInput {
                card_id: Some("  bolt-lea  ".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let plain = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(padded.id, plain.id);
        assert_eq!(plain.quantity, 2);
        let stored: String = conn
            .query_row("SELECT card_id FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "bolt-lea");
    }

    #[test]
    fn wish_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(WishRow {
            id: 3,
            oracle_id: Some("o1".into()),
            card_id: None,
            name: "Lightning Bolt".into(),
            set_code: None,
            collector_number: None,
            lang: None,
            rarity: Some("common".into()),
            mana_cost: Some("{R}".into()),
            type_line: Some("Instant".into()),
            art_card_id: Some("bolt-2ed".into()),
            quantity: 4,
            preferred_finish: Some("foil".into()),
            unit_price: Some(40.0),
            owned_quantity: 2,
            notes: None,
            needs_review: None,
            updated_at: 1_800_000_000,
            legalities: Some(r#"{"timeless":"legal"}"#.into()),
            folder_id: Some(7),
            elsewhere: 1,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "oracleId": "o1", "cardId": null, "name": "Lightning Bolt",
                "setCode": null, "collectorNumber": null, "lang": null, "rarity": "common",
                "manaCost": "{R}", "typeLine": "Instant", "artCardId": "bolt-2ed",
                "quantity": 4, "preferredFinish": "foil",
                "unitPrice": 40.0, "ownedQuantity": 2, "notes": null,
                "needsReview": null, "updatedAt": 1800000000,
                "legalities": "{\"timeless\":\"legal\"}",
                "folderId": 7, "elsewhere": 1
            })
        );
    }

    /// The page is what the frontend receives, so its wrapper is pinned too — and the
    /// invoke payload is what it sends: `#[serde(default)]` plus the flattened card
    /// filters, which a caller omits entirely until it filters by one.
    #[test]
    fn the_page_and_the_query_carry_the_names_the_frontend_uses() {
        let value = serde_json::to_value(WishlistPage {
            items: vec![],
            total: 0,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({ "items": [], "total": 0 }));

        let q: WishlistQuery = serde_json::from_str(
            r#"{"text":"bolt","sets":["lea"],"fulfilled":false,"needsReview":true}"#,
        )
        .unwrap();
        assert_eq!(q.cards.text.as_deref(), Some("bolt"));
        assert_eq!(q.cards.sets.unwrap(), vec!["lea".to_owned()]);
        assert_eq!(q.fulfilled, Some(false));
        assert_eq!(q.needs_review, Some(true), "camelCase on the way in, too");
        assert_eq!(q.limit, 0, "omitted limit means unset, not a parse error");
        assert_eq!(q.folder_id, None, "omitted is the root");
        assert!(
            !q.flatten,
            "and omitted `flatten` reads the root rather than everything — which is what \
             every caller written before folders existed already asks for"
        );

        let filed: WishlistQuery =
            serde_json::from_str(r#"{"folderId":4,"flatten":true}"#).unwrap();
        assert_eq!(filed.folder_id, Some(4));
        assert!(filed.flatten);
    }

    /// A wish outlives the printing it was made from — that is what the denormalised
    /// columns are for — and the list has to keep showing it under the set code it
    /// records, including when the reader filters to that code.
    #[test]
    fn a_wish_survives_its_printing_leaving_the_card_database() {
        let conn = seeded();
        let wish = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let filtered = list_wishes(
            &conn,
            &WishlistQuery {
                cards: crate::filters::CardFilters {
                    set_code: Some("lea".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.total, 1);
        let row = &filtered.items[0];
        assert_eq!(row.id, wish.id);
        assert_eq!(row.name, "Lightning Bolt", "the name is the wish's own");
        assert_eq!(row.rarity, None, "nothing is invented for a gone printing");
        assert_eq!(row.unit_price, None);
    }

    /// Free text filters the wish's *own* name, which is the only name an any-printing
    /// wish has.
    #[test]
    fn the_text_filter_matches_the_name_the_wish_carries() {
        let conn = seeded();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-recall".into()),
                name: Some("Ancestral Recall".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let hit = list_wishes(
            &conn,
            &WishlistQuery {
                cards: crate::filters::CardFilters {
                    text: Some("ancestral".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hit.total, 1);
        assert_eq!(hit.items[0].name, "Ancestral Recall");
    }

    /// `LIKE`'s wildcards are ordinary characters in a search box, and unescaped they turn
    /// a filter into one that does not filter — the failure nobody reports, because a list
    /// showing too much still looks like a list. `_` is the dangerous one: it is a
    /// keystroke away from the `-` in half the card names in Magic.
    #[test]
    fn the_text_filter_treats_like_wildcards_as_the_characters_they_are() {
        let conn = seeded();
        for name in ["Lightning Bolt", "God-Pharaoh's Gift", "100% Sure Thing"] {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some(format!("o-{name}")),
                    name: Some(name.to_owned()),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let found = |text: &str| {
            list_wishes(
                &conn,
                &WishlistQuery {
                    cards: crate::filters::CardFilters {
                        text: Some(text.to_owned()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .iter()
            .map(|r| r.name.clone())
            .collect::<Vec<_>>()
        };

        assert_eq!(
            found("%"),
            ["100% Sure Thing"],
            "a per-cent sign is a character"
        );
        assert_eq!(found("God_Pharaoh"), Vec::<String>::new(), "`_` is not `-`");
        assert_eq!(found("God-Pharaoh"), ["God-Pharaoh's Gift"]);
        // The escape character itself, which the escaping has to escape first of all.
        //
        // **Neither of these two lines is a fence** — the fences are `%` and `God_Pharaoh`
        // above, which fail the moment the escaping stops. A backslash reaches SQLite as a
        // *bound parameter*, so it can never be a prepare error whatever it contains, and
        // SQLite's `LIKE` treats a trailing escape as matching nothing rather than raising:
        // both of these answer with an empty list escaped or not. They are here as recorded
        // behaviour — no name in Magic contains a backslash, so "nothing found" is the
        // right answer and worth pinning — not as protection.
        assert_eq!(found("\\"), Vec::<String>::new());
        assert_eq!(found("\\%"), Vec::<String>::new());
        assert_eq!(
            found("bolt"),
            ["Lightning Bolt"],
            "and ordinary text still works"
        );
    }

    /// Every sort key, exercised — because `price` orders by a *select alias* over a
    /// `NULLS LAST` clause, and an `ORDER BY` SQLite cannot resolve is a failure at
    /// **prepare** time: the whole list, not one row out of place. The unknown key is here
    /// for the reason the search's twin is: `sort` is matched against literals and never
    /// interpolated, and the value below would be a syntax error if it ever reached the SQL.
    #[test]
    fn every_sort_key_orders_the_list_and_an_unknown_one_falls_back_to_name() {
        let conn = seeded();
        let wish = |name: &str, oracle: &str, quantity: i64, finish: Option<&str>| {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some(oracle.to_owned()),
                    name: Some(name.to_owned()),
                    preferred_finish: finish.map(str::to_owned),
                    quantity,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };
        // Two wishes on the priced printing (nonfoil $5, foil $40) and one on an oracle
        // card with no printing at all, so the price sort has a NULL to place.
        let cheap = wish("Lightning Bolt", "o1", 1, None);
        let dear = wish("Lightning Bolt", "o1", 2, Some("foil"));
        let unpriced = wish("Ancestral Recall", "o-recall", 9, None);

        let by = |sort: Vec<crate::sorting::SortTerm>| {
            list_wishes(
                &conn,
                &WishlistQuery {
                    sort: Some(sort),
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>()
        };
        let ids = |key: &str, dir: &str| by(vec![term(key, dir)]);

        assert_eq!(
            ids("price", "desc"),
            vec![dear, cheap, unpriced],
            "dearest first"
        );
        assert_eq!(ids("quantity", "desc"), vec![unpriced, dear, cheap]);
        assert_eq!(
            ids("added", "desc"),
            vec![unpriced, dear, cheap],
            "newest first"
        );
        assert_eq!(
            ids("name", "asc"),
            vec![unpriced, cheap, dear],
            "A before L"
        );
        // Reversing a sort reverses the rows rather than moving the holes: every nullable
        // column states its null rule in both directions.
        assert_eq!(
            ids("price", "asc"),
            vec![cheap, dear, unpriced],
            "cheapest first, NULL last"
        );
        // Nothing owned, so `owned` ties every row and only the tiebreak separates them.
        assert_eq!(ids("owned", "desc").len(), 3);
        // Cost is unit × copies still missing: 9 unpriced (no cost), $40 × 2, $5 × 1.
        assert_eq!(ids("cost", "desc"), vec![dear, cheap, unpriced]);
        assert_eq!(
            by(vec![term("c.name; DROP TABLE wishlist_entries", "asc")]),
            ids("name", "asc")
        );
    }

    /// The Cost column shows unit price × copies *still missing*, so its header sorts by
    /// that — a fulfilled wish costs nothing however dear the card is, which is the one
    /// thing the unit-price order cannot say.
    #[test]
    fn cost_sorts_by_what_is_left_to_buy_and_price_by_the_unit() {
        let conn = seeded();
        // A $40 foil, wanted once and already owned; a $5 nonfoil, wanted twice and owned
        // not at all.
        let dear = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                preferred_finish: Some("foil".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let cheap = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-2ed".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        conn.execute(
            "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                 condition,quantity,created_at,updated_at)
             VALUES ('bolt-lea','lea','161','en','foil','NM',1,0,0)",
            [],
        )
        .unwrap();

        let first = |key: &str| {
            list_wishes(
                &conn,
                &WishlistQuery {
                    sort: Some(vec![term(key, "desc")]),
                    ..Default::default()
                },
            )
            .unwrap()
            .items[0]
                .id
        };
        assert_eq!(
            first("cost"),
            cheap,
            "$5 × 2 still to buy beats $40 already owned"
        );
        assert_eq!(
            first("price"),
            dear,
            "and the $40 foil is still the dearest card"
        );
    }

    /// The price is the one the wish would be filled at: the preferred finish's, or the
    /// nonfoil one when the wish names no finish.
    #[test]
    fn the_unit_price_follows_the_preferred_finish() {
        let conn = seeded();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                preferred_finish: Some("foil".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                preferred_finish: Some("etched".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let price_of = |finish: Option<&str>| {
            rows.items
                .iter()
                .find(|r| r.preferred_finish.as_deref() == finish)
                .unwrap()
                .unit_price
        };
        assert_eq!(price_of(None), Some(5.0));
        assert_eq!(price_of(Some("foil")), Some(40.0));
        assert_eq!(
            price_of(Some("etched")),
            None,
            "no etched price is not the nonfoil price"
        );
    }

    /// A wish that names **no** finish is a wish for the card, so it is priced at the printing's
    /// own chain — `nonfoil → foil → etched` — exactly as a deck row with a null finish is.
    ///
    /// This is the Wakka case, which is where the bug was reported from: FIC #477 is sold only in
    /// foil, so `coalesce(preferred_finish, 'nonfoil')` asked for a `$.usd` that does not exist
    /// and drew an em dash beside a search wall quoting the same printing at $31.18. 12 849 of
    /// 116 843 printings are priced only in foil or etched, so this is 11 % of anything a reader
    /// can wish for.
    #[test]
    fn a_wish_with_no_preferred_finish_falls_through_to_the_foil_price() {
        let conn = empty();
        seed_card_with_prices(
            &conn,
            "wakka-fic",
            r#"["foil"]"#,
            r#"{"usd": null, "usd_foil": "31.18"}"#,
        );
        add_pinned_wish(&conn, "wakka-fic", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(
            page.items[0].unit_price,
            Some(31.18),
            "a foil-only printing is quoted at its foil rate, not left unpriced"
        );
    }

    /// A wish that **does** name a finish is priced at that finish and at no other. No fallback of
    /// any kind: the reader has said which object they want, and an em dash means "this
    /// marketplace does not quote this printing in this finish", never "look somewhere else".
    #[test]
    fn a_named_finish_never_falls_back_to_another_ones_price() {
        let conn = empty();
        seed_card_with_prices(
            &conn,
            "bolt-both",
            r#"["nonfoil","foil"]"#,
            r#"{"usd": "1.00", "usd_foil": "9.00"}"#,
        );
        add_pinned_wish(&conn, "bolt-both", Some("foil"));
        add_pinned_wish(&conn, "bolt-both", Some("etched"));

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();
        let priced: Vec<Option<f64>> = page.items.iter().map(|r| r.unit_price).collect();

        assert!(
            priced.contains(&Some(9.00)),
            "the foil wish is quoted at the foil rate"
        );
        assert!(
            priced.contains(&None),
            "the etched wish is unpriced — this printing is not sold etched, and quoting the \
             nonfoil rate for it would be a price nobody quoted"
        );
        assert!(
            !priced.contains(&Some(1.00)),
            "and neither wish is ever quoted at the nonfoil rate"
        );
    }

    /// The backend half plan-3 deferred: `Some(true)` narrows to flagged wishes,
    /// `Some(false)` to clean ones, `None` asks nothing — CollectionQuery's exact contract.
    #[test]
    fn the_needs_review_filter_narrows_the_list_and_the_count() {
        let conn = seeded();
        let wish = |card: &str| {
            add_wish(
                &conn,
                &WishInput {
                    card_id: Some(card.to_owned()),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };
        let flagged = wish("bolt-lea");
        let clean = wish("bolt-2ed");
        // What the reconciler leaves behind, written straight onto the row: `sweep_orphans`
        // walks `wishlist_entries` as well as `collection_entries`, and this filter is the
        // only way to reach what it wrote.
        conn.execute(
            "UPDATE wishlist_entries SET needs_review = ?2 WHERE id = ?1",
            params![flagged, "Scryfall removed this printing from its database."],
        )
        .unwrap();

        let ids = |needs_review: Option<bool>| {
            let page = list_wishes(
                &conn,
                &WishlistQuery {
                    needs_review,
                    ..Default::default()
                },
            )
            .unwrap();
            // The count is filtered by the same predicate as the page, or the header counts
            // rows the list is not showing.
            assert_eq!(
                page.total,
                page.items.len() as i64,
                "count agrees with page"
            );
            page.items.iter().map(|r| r.id).collect::<Vec<_>>()
        };
        assert_eq!(ids(Some(true)), vec![flagged]);
        assert_eq!(ids(Some(false)), vec![clean]);
        assert_eq!(ids(None), vec![flagged, clean], "None asks nothing");

        // And the sentence itself still rides on the row, which is what the band renders.
        let page = list_wishes(
            &conn,
            &WishlistQuery {
                needs_review: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(page.items[0]
            .needs_review
            .as_deref()
            .is_some_and(|s| s.contains("removed this printing")));
    }

    /// Cardmarket per copy follows the wish's own finish, with the hole the data has: a foil
    /// wish prices at `eur_foil`, an etched wish is NULL — unpriced, never the nonfoil rate.
    #[test]
    fn a_cardmarket_price_reads_the_blob_by_preferred_finish_and_etched_is_unpriced() {
        let conn = seeded();
        for finish in [None, Some("foil"), Some("etched")] {
            add_wish(
                &conn,
                &WishInput {
                    card_id: Some("bolt-lea".into()),
                    preferred_finish: finish.map(str::to_owned),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        }

        let on = |marketplace| WishlistQuery {
            marketplace,
            ..Default::default()
        };
        let rows = list_wishes(&conn, &on(crate::sorting::Marketplace::Cardmarket)).unwrap();
        let eur_of = |finish: Option<&str>| {
            rows.items
                .iter()
                .find(|r| r.preferred_finish.as_deref() == finish)
                .unwrap()
                .unit_price
        };
        assert_eq!(eur_of(None), Some(4.00));
        assert_eq!(eur_of(Some("foil")), Some(32.00));
        // `$.eur` is *there* — 4.00 — which is exactly what a naive fallback would charge
        // for the etched copy. `eur_etched` is documented and does not exist in the data, so
        // the honest answer is no price at all.
        assert_eq!(
            eur_of(Some("etched")),
            None,
            "there is no eur_etched key, and the nonfoil rate is not a stand-in"
        );

        // A wish whose printing has left `cards` is unpriced everywhere: there is no blob to
        // read, and no id a feed could be joined on either.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();
        for marketplace in MARKETPLACES {
            let orphaned = list_wishes(&conn, &on(marketplace)).unwrap();
            assert!(
                orphaned.items.iter().all(|r| r.unit_price.is_none()),
                "{marketplace:?}"
            );
        }
    }

    /// Every marketplace a price can come from — [`crate::collection`]'s list, kept per module
    /// so neither can be extended without the other noticing.
    const MARKETPLACES: [crate::sorting::Marketplace; 4] = [
        crate::sorting::Marketplace::Tcgplayer,
        crate::sorting::Marketplace::Cardmarket,
        crate::sorting::Marketplace::Cardkingdom,
        crate::sorting::Marketplace::Manapool,
    ];

    /// `sorting`'s rule over this table's money keys: a clause with no `{price}` hole in it
    /// quotes one marketplace whatever the reader picked.
    #[test]
    fn every_wishlist_money_sort_names_the_price_hole() {
        for p in WISHLIST_PRICE_SORTS {
            assert!(p.asc.contains(crate::sorting::PRICE_HOLE), "{}", p.asc);
            assert!(p.desc.contains(crate::sorting::PRICE_HOLE), "{}", p.desc);
        }
    }

    /// Rows in `marketplace_prices` — [`crate::collection`]'s helper, kept per module.
    fn seed_feed(conn: &Connection, rows: &[(&str, &str, &str, f64)]) {
        for (marketplace, card_id, finish, price) in rows {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_prices
                    (marketplace, card_id, finish, price) VALUES (?1,?2,?3,?4)",
                rusqlite::params![marketplace, card_id, finish, price],
            )
            .unwrap();
        }
    }

    /// Three wishes whose order disagrees between every pair of marketplaces, one of them for
    /// the **etched** printing — whose blob names a `$.eur` that the etched wish must not
    /// take, and which Card Kingdom's feed has never listed while Mana Pool's has. Quantities
    /// differ too, so `cost` and `price` cannot agree by accident.
    fn seeded_marketplaces() -> Connection {
        let conn = crate::schema::memory_pair();
        for (id, prices) in [
            ("cheap-usd", r#"{"usd":"1.00","eur":"90.00"}"#),
            ("dear-usd", r#"{"usd":"50.00","eur":"2.00"}"#),
            (
                "etched",
                r#"{"usd":"9.00","usd_etched":"9.00","eur":"7.00"}"#,
            ),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,raw)
                 VALUES (?1,?1,?1,'tst','1','en','normal',?2,'{}')",
                rusqlite::params![id, prices],
            )
            .unwrap();
        }
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "cheap-usd", "nonfoil", 3.00),
                ("cardkingdom", "dear-usd", "nonfoil", 20.00),
                // and no `cardkingdom` row for the etched printing at all.
                ("manapool", "cheap-usd", "nonfoil", 8.00),
                ("manapool", "dear-usd", "nonfoil", 1.00),
                ("manapool", "etched", "etched", 4.00),
            ],
        );
        for (card, finish, quantity) in [
            ("cheap-usd", None, 10),
            ("dear-usd", None, 1),
            ("etched", Some("etched"), 2),
        ] {
            add_wish(
                &conn,
                &WishInput {
                    card_id: Some(card.to_owned()),
                    preferred_finish: finish.map(str::to_owned),
                    quantity,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        conn
    }

    /// Ordering happens inside SQLite, so the chosen marketplace has to reach it. Both keys,
    /// both directions, all four shops — and the etched wish, unpriced on two of them, stays
    /// last whichever way those two run.
    #[test]
    fn the_cost_and_price_sorts_order_by_the_marketplace_they_are_asked_for() {
        let conn = seeded_marketplaces();
        let names = |key: &str, dir: &str, marketplace| -> Vec<String> {
            list_wishes(
                &conn,
                &WishlistQuery {
                    sort: Some(vec![term(key, dir)]),
                    marketplace,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .into_iter()
            .map(|r| r.name)
            .collect()
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};
        let order = |ids: &str| -> Vec<String> { ids.split(',').map(str::to_owned).collect() };

        // Per copy. TCGplayer $1 / $50 / $9; Cardmarket €90 / €2 / —; Card Kingdom
        // $3 / $20 / — (no feed row); Mana Pool $8 / $1 / $4.
        assert_eq!(
            names("price", "asc", Tcgplayer),
            order("cheap-usd,etched,dear-usd")
        );
        assert_eq!(
            names("price", "desc", Tcgplayer),
            order("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            names("price", "asc", Cardmarket),
            order("dear-usd,cheap-usd,etched")
        );
        assert_eq!(
            names("price", "desc", Cardmarket),
            order("cheap-usd,dear-usd,etched")
        );
        assert_eq!(
            names("price", "asc", Cardkingdom),
            order("cheap-usd,dear-usd,etched"),
            "a printing the feed has never listed is unpriced and sorts last"
        );
        assert_eq!(
            names("price", "desc", Cardkingdom),
            order("dear-usd,cheap-usd,etched")
        );
        assert_eq!(
            names("price", "asc", Manapool),
            order("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            names("price", "desc", Manapool),
            order("cheap-usd,etched,dear-usd"),
            "Mana Pool quotes etched, so the etched wish places rather than trails"
        );

        // × the copies still missing, and nothing is owned: 10 / 1 / 2. TCGplayer
        // $10 / $50 / $18; Cardmarket €900 / €2 / —; Card Kingdom $30 / $20 / —;
        // Mana Pool $80 / $1 / $8.
        assert_eq!(
            names("cost", "asc", Tcgplayer),
            order("cheap-usd,etched,dear-usd")
        );
        assert_eq!(
            names("cost", "desc", Tcgplayer),
            order("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            names("cost", "asc", Cardmarket),
            order("dear-usd,cheap-usd,etched")
        );
        assert_eq!(
            names("cost", "desc", Cardmarket),
            order("cheap-usd,dear-usd,etched")
        );
        assert_eq!(
            names("cost", "asc", Cardkingdom),
            order("dear-usd,cheap-usd,etched"),
            "`cost` and `price` disagree on Card Kingdom, which is what the copies are for"
        );
        assert_eq!(
            names("cost", "desc", Cardkingdom),
            order("cheap-usd,dear-usd,etched")
        );
        assert_eq!(
            names("cost", "asc", Manapool),
            order("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            names("cost", "desc", Manapool),
            order("cheap-usd,etched,dear-usd")
        );
    }

    /// Each marketplace writes a *different expression* into the same statement, and two of
    /// them reach a table this query does not join — so every key is its own chance to fail
    /// at **prepare** time, on one shop and not the others.
    #[test]
    fn every_sort_key_prepares_at_every_marketplace() {
        let conn = seeded_marketplaces();
        for marketplace in MARKETPLACES {
            for key in [
                "name", "owned", "quantity", "cost", "price", "added", "nope",
            ] {
                for dir in ["asc", "desc"] {
                    let page = list_wishes(
                        &conn,
                        &WishlistQuery {
                            sort: Some(vec![term(key, dir)]),
                            marketplace,
                            ..Default::default()
                        },
                    )
                    .unwrap_or_else(|e| {
                        panic!("sorting by `{key}` {dir} on {marketplace:?} failed: {e}")
                    });
                    assert_eq!(page.items.len(), 3);
                }
            }
        }
    }

    /// Absent means TCGplayer — the prices every caller had before there was a picker — and
    /// so does an id this build has never heard of.
    #[test]
    fn a_query_with_no_marketplace_quotes_tcgplayer() {
        let conn = seeded_marketplaces();
        let names = |json: &str| -> Vec<String> {
            let q: WishlistQuery = serde_json::from_str(json).unwrap();
            list_wishes(&conn, &q)
                .unwrap()
                .items
                .into_iter()
                .map(|r| r.name)
                .collect()
        };
        let sort = r#""sort":[{"key":"price","dir":"asc"}]"#;

        let tcgplayer = ["cheap-usd", "etched", "dear-usd"];
        assert_eq!(names(&format!("{{{sort}}}")), tcgplayer, "absent");
        assert_eq!(
            names(&format!(r#"{{{sort},"marketplace":"ebay"}}"#)),
            tcgplayer,
            "and an id this build has never heard of"
        );
        assert_eq!(
            names(&format!(r#"{{{sort},"marketplace":"cardkingdom"}}"#)),
            ["cheap-usd", "dear-usd", "etched"]
        );
    }

    #[test]
    fn an_add_import_accumulates_on_the_wishlist_grain() {
        let conn = seeded();
        let out = commit_import(&conn, &[wish("oracle-1", 2), wish("oracle-1", 1)], "add").unwrap();
        assert_eq!(out.added, 1);
        assert_eq!(out.updated, 1);
        assert_eq!(quantity_of(&conn, "oracle-1"), 3);
    }

    #[test]
    fn a_set_of_zero_removes_the_wish_rather_than_leaving_an_empty_one() {
        // The wishlist's own asymmetry, not a new rule: `wishlist_set_quantity(id, 0)` already
        // deletes, because a wish for nothing is not a wish.
        let conn = seeded();
        commit_import(&conn, &[wish("oracle-1", 2)], "add").unwrap();
        let out = commit_import(&conn, &[wish("oracle-1", 0)], "set").unwrap();
        assert_eq!(out.removed, 1);
        assert_eq!(wish_count(&conn), 0);
    }

    #[test]
    fn a_wish_for_any_printing_is_a_different_row_from_a_wish_for_one() {
        let conn = seeded();
        commit_import(
            &conn,
            &[wish("oracle-1", 1), pinned_wish("oracle-1", "card-1", 1)],
            "add",
        )
        .unwrap();
        assert_eq!(wish_count(&conn), 2);
    }

    #[test]
    fn a_refused_item_rolls_the_whole_file_back() {
        let conn = seeded();
        let items = vec![wish("oracle-1", 1), bad_finish_wish("oracle-2", 1)];
        assert!(commit_import(&conn, &items, "add").is_err());
        assert_eq!(wish_count(&conn), 0);
    }

    #[test]
    fn an_unknown_mode_is_refused_rather_than_defaulted() {
        let conn = seeded();
        assert!(commit_import(&conn, &[wish("oracle-1", 1)], "replace").is_err());
    }

    /// The trap `removed` being counted explicitly (rather than derived from a before/after row
    /// count) exists for: one line creates a row and another zeroes an existing one, in the
    /// *same* `set` call. A row-count delta alone would cancel these two events out and report
    /// neither — this is the one path where that would still hide.
    ///
    /// Worked by hand: before the import, one wish exists (`oracle-1`, any printing, seeded via
    /// `add`). The first item names that exact grain at quantity `0` — `add_wish`'s own fold
    /// (which never subtracts) briefly raises it, and the immediate `set_wish_quantity` to `0`
    /// deletes it: `removed` becomes 1, the row count drops by one. The second item names a
    /// different grain (pinned to `card-1`) that does not exist yet, so it is created and then
    /// set to 5 — a genuinely new row, the row count rises by one. Net row count is therefore
    /// unchanged (1 → 1), which is exactly the case that would read as "nothing happened"
    /// without the explicit counter: `added = (after - before) + removed = (1 - 1) + 1 = 1`,
    /// `removed = 1`, `updated = items.len() - added - removed = 2 - 1 - 1 = 0`.
    #[test]
    fn a_mixed_set_import_creates_one_row_and_removes_another_without_losing_either_count() {
        let conn = seeded();
        commit_import(&conn, &[wish("oracle-1", 2)], "add").unwrap();
        let out = commit_import(
            &conn,
            &[
                // Same grain as the seeded wish: zeroed by this line.
                wish("oracle-1", 0),
                // A different grain (pinned to a printing): a genuinely new row.
                pinned_wish("oracle-1", "card-1", 5),
            ],
            "set",
        )
        .unwrap();
        assert_eq!(out.added, 1, "only the pinned row is genuinely new");
        assert_eq!(out.removed, 1, "the any-printing wish was zeroed away");
        assert_eq!(out.updated, 0);
        assert_eq!(wish_count(&conn), 1);
    }

    /// **The fourth term of [`WISHLIST_GRAIN`], reached through the command rather than
    /// through the index.** `schema` proves the index separates two folders; this proves the
    /// thing that matters to a reader — pressing "Add to Ordered" on a card already on the
    /// list makes a *second* wish and leaves the first exactly where they filed it.
    ///
    /// The root row's quantity is re-read rather than taken from the first add's answer,
    /// because "it folded" and "it did not fold" differ in nothing else: a grain that had
    /// lost this term would return the same two `EntryChange`s with the same ids and quietly
    /// have put four copies on one row.
    #[test]
    fn add_wish_with_a_folder_makes_a_second_wish_beside_a_root_one() {
        let conn = seeded();
        folder(&conn, 1, None, "Ordered");
        let at_root = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let filed = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 3,
                folder_id: Some(1),
                ..Default::default()
            },
        )
        .unwrap();

        assert_ne!(at_root.id, filed.id, "two places, two wishes");
        assert_eq!(wish_count(&conn), 2);
        let (quantity, folder_id): (i64, Option<i64>) = conn
            .query_row(
                "SELECT quantity, folder_id FROM wishlist_entries WHERE id = ?1",
                params![at_root.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            quantity, 1,
            "the wish the reader already had is not added to"
        );
        assert_eq!(folder_id, None, "nor moved out of the root");
    }

    /// A folder id nothing answers to is refused **in words**, and the sentence is the one the
    /// other two writes over this column already give.
    ///
    /// `wishlist_entries.folder_id` carries a real foreign key, so this write was already
    /// impossible — but only while `PRAGMA foreign_keys` is on, and the answer was
    /// `FOREIGN KEY constraint failed`. A reader who deleted `Ordered` in one pane then got
    /// that from **Add to → Wishlist → Ordered** and "That folder is not there any more." from
    /// **Move to folder…**, over one column and one mistake.
    #[test]
    fn add_wish_refuses_a_folder_that_is_not_there() {
        let conn = seeded();
        let err = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                folder_id: Some(404),
                ..Default::default()
            },
        )
        .unwrap_err();

        assert_eq!(err, FOLDER_GONE);
        assert_eq!(wish_count(&conn), 0, "and the refused add wrote nothing");
    }

    /// And the fold still bites *inside* a folder, which is the half a grain that had simply
    /// gone loose would fail. Two adds into `Ordered` are one wish for four copies —
    /// `wishing_twice_for_the_same_thing_raises_the_quantity`, one folder over.
    #[test]
    fn add_wish_twice_into_one_folder_folds_onto_the_same_row() {
        let conn = seeded();
        folder(&conn, 1, None, "Ordered");
        let into_ordered = |quantity: i64| {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("o1".into()),
                    quantity,
                    folder_id: Some(1),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let first = into_ordered(1);
        let second = into_ordered(3);

        assert_eq!((first.id, second.quantity), (second.id, 4));
        assert_eq!(wish_count(&conn), 1, "one wish, filed once");
    }

    /// The root is a **place**, not the whole list. `folder_id: None, flatten: false` — which
    /// is [`WishlistQuery::default`], so this is also what every caller written before folders
    /// existed now asks for, and the answer is the list they have always been shown.
    #[test]
    fn list_wishes_at_the_root_leaves_out_what_is_filed() {
        let (conn, root, _, _) = filed_three_ways();
        let page = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, root);
        assert_eq!(page.items[0].folder_id, None);
    }

    /// Direct members only. The wish in `Ordered/Someday` is in the tree under `Ordered` and
    /// is deliberately not on `Ordered`'s page: the tree does the summing, for the reason
    /// `wishlist_folder_summary` gives — SQL that walked the tree would be a second
    /// implementation of arithmetic `folderTree.ts` already does for the deck gallery.
    #[test]
    fn list_wishes_in_a_folder_leaves_out_the_root_and_the_subfolders() {
        let (conn, _, ordered, _) = filed_three_ways();
        let page = list_wishes(
            &conn,
            &WishlistQuery {
                folder_id: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, ordered);
        assert_eq!(page.items[0].folder_id, Some(1));
    }

    /// **Flatten**, and the field is given a folder to ignore on purpose: `flatten` is not a
    /// third value of `folder_id` but a question about whether that field is read at all, and
    /// a test that flattened from the root could not tell the two apart.
    #[test]
    fn list_wishes_flattened_answers_every_wish_wherever_it_is() {
        let (conn, root, ordered, someday) = filed_three_ways();
        let page = list_wishes(
            &conn,
            &WishlistQuery {
                folder_id: Some(2),
                flatten: true,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(page.total, 3);
        let mut found: Vec<i64> = page.items.iter().map(|r| r.id).collect();
        found.sort_unstable();
        let mut expected = vec![root, ordered, someday];
        expected.sort_unstable();
        assert_eq!(found, expected, "the folder given is not read at all");
    }

    /// The "also on your list" mark, which is what makes the grain's fourth term affordable:
    /// three writers add at the root and cannot name a folder, so a card the reader filed in
    /// `Ordered` can acquire a second root row without anyone deciding to make one.
    ///
    /// Counted across folders, because that is the pair worth knowing about — and `0` for the
    /// two orphans, which is the fence rather than the arithmetic: they have no oracle id, and
    /// a rewrite that coalesced the comparison to `''` would have them count each other and
    /// tell the reader that a wish for the Alpha Bolt is "also on your list" as a wish for an
    /// unrelated card.
    #[test]
    fn elsewhere_counts_the_other_wishes_for_the_same_oracle_card() {
        let conn = seeded();
        folder(&conn, 1, None, "Ordered");
        let bolt = |folder_id: Option<i64>| {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("o1".into()),
                    quantity: 1,
                    folder_id,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };
        let (at_root, filed) = (bolt(None), bolt(Some(1)));
        let lone = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("oracle-1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        // Two wishes with no oracle card at all — the shape `add_wish` cannot make, because a
        // printing it can look up carries one. Only the reconciler's orphans and a database
        // that predates a printing's oracle id ever look like this.
        let orphan = |card_id: &str| -> i64 {
            conn.query_row(
                "INSERT INTO wishlist_entries (card_id, name, quantity, created_at, updated_at)
                 VALUES (?1, 'Lightning Bolt', 1, unixepoch(), unixepoch()) RETURNING id",
                params![card_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let (first_orphan, second_orphan) = (orphan("bolt-lea"), orphan("bolt-2ed"));

        let page = list_wishes(
            &conn,
            &WishlistQuery {
                flatten: true,
                ..Default::default()
            },
        )
        .unwrap();
        let elsewhere = |id: i64| page.items.iter().find(|r| r.id == id).unwrap().elsewhere;
        assert_eq!(elsewhere(at_root), 1, "the one in `Ordered`");
        assert_eq!(elsewhere(filed), 1, "and the one at the root");
        assert_eq!(elsewhere(lone), 0, "nobody else wants that card");
        assert_eq!(elsewhere(first_orphan), 0);
        assert_eq!(
            elsewhere(second_orphan),
            0,
            "two wishes with no oracle card are not two wishes for the same one"
        );
    }

    /// "Use this printing", from an any-printing wish. The three denormalised columns are the
    /// point: they describe a *printing*, they are what the list prints, and a pin that left
    /// them behind would draw a wish as `lea` while pointing at the 2ed card.
    #[test]
    fn set_wish_printing_pins_a_wish_and_refreshes_its_set_and_number() {
        let conn = seeded();
        let open = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();

        let after = set_wish_printing(&conn, open.id, Some("bolt-lea".into())).unwrap();

        assert_eq!(
            (after.id, after.quantity, after.removed),
            (open.id, 2, false),
            "same wish, same copies wanted"
        );
        let page = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let row = &page.items[0];
        assert_eq!(row.card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(row.set_code.as_deref(), Some("lea"));
        assert_eq!(row.collector_number.as_deref(), Some("161"));
        assert_eq!(row.lang.as_deref(), Some("en"));
        assert_eq!(row.name, "Lightning Bolt", "the oracle name is unchanged");
        assert_eq!(
            row.quantity, 2,
            "and the copies are the row's, not just the answer's"
        );
    }

    /// And back. All four columns go NULL together, because that is the only shape "any
    /// printing" has — a wish still carrying `lea` in the set column while `card_id` is NULL
    /// would draw as pinned in a list that reads the denormalised columns.
    #[test]
    fn set_wish_printing_to_none_returns_a_wish_to_any_printing() {
        let conn = seeded();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        set_wish_printing(&conn, pinned.id, None).unwrap();

        let page = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let row = &page.items[0];
        assert_eq!(row.card_id, None);
        assert_eq!(row.set_code, None);
        assert_eq!(row.collector_number, None);
        assert_eq!(row.lang, None);
        assert_eq!(
            row.oracle_id.as_deref(),
            Some("o1"),
            "the card the wish is for is what is left of it"
        );
    }

    /// [`add_wish`]'s sentence, because it is [`add_wish`]'s fact — one wording for "that id
    /// is not in `cards`" rather than two to keep in step. And nothing is written: a refusal
    /// that had already cleared the row's set code would leave the wish describing a printing
    /// it is not for.
    #[test]
    fn set_wish_printing_refuses_a_card_the_database_does_not_have() {
        let conn = seeded();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let err = set_wish_printing(&conn, pinned.id, Some("bolt-unhinged".into())).unwrap_err();

        assert!(err.contains("no card with that id"), "{err}");
        let (card_id, set_code): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT card_id, set_code FROM wishlist_entries WHERE id = ?1",
                params![pinned.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(set_code.as_deref(), Some("lea"));
    }

    /// The table's `CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)`, **said in the
    /// app's voice before the database says it in its own**: a wish that names no oracle card
    /// has its printing and nothing else, so there is no card left to want any printing of.
    /// `an_unknown_preferred_finish_is_refused_with_a_sentence`'s shape, and its second
    /// assertion — a reader must never be shown the constraint's own wording.
    #[test]
    fn set_wish_printing_refuses_unpinning_a_wish_that_has_no_oracle_card() {
        let conn = seeded();
        let id: i64 = conn
            .query_row(
                "INSERT INTO wishlist_entries (card_id, name, quantity, created_at, updated_at)
                 VALUES ('bolt-lea', 'Lightning Bolt', 1, unixepoch(), unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let err = set_wish_printing(&conn, id, None).unwrap_err();

        // Spanning the `\` continuation in the literal on purpose: `cargo fmt` turns one of
        // those into a run of literal spaces if it ever re-indents the line, and every other
        // check in this crate stays green while a reader is shown "no       card".
        assert!(
            err.contains("there is no card to want any printing of"),
            "{err}"
        );
        assert!(!err.contains("CHECK"), "{err}");
        let card_id: Option<String> = conn
            .query_row(
                "SELECT card_id FROM wishlist_entries WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            card_id.as_deref(),
            Some("bolt-lea"),
            "and nothing was cleared"
        );
    }

    /// The merge, and the rule `wishlist_folders::set_wish_folder` shares: a write that lands
    /// on a taken grain **merges rather than fails**. Un-pinning the Alpha Bolt while an
    /// any-printing Bolt wish sits in the same folder is the reader saying those are one wish,
    /// and `UNIQUE constraint failed` would be the app telling them off for agreeing with it.
    ///
    /// The note comes across because the survivor has none — [`add_wish`]'s `ON CONFLICT`
    /// rule, and the reconciler's fold — and the answer names the **destination**, which is
    /// the id the caller has to select afterwards.
    #[test]
    fn set_wish_printing_merges_onto_a_wish_the_grain_already_holds() {
        let conn = seeded();
        let open = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let alpha = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 3,
                notes: Some("from the trade binder".into()),
                ..Default::default()
            },
        )
        .unwrap();

        let after = set_wish_printing(&conn, alpha.id, None).unwrap();

        assert_eq!(after.id, open.id, "the answer names the row that survived");
        assert_eq!(after.quantity, 5, "three copies wanted plus two, not two");
        assert!(
            !after.removed,
            "the wish is still on the list — `removed` means the wish is gone, not the row"
        );
        assert_eq!(wish_count(&conn), 1);
        // **Read back, never trusted.** `after.quantity` is arithmetic this module did in
        // Rust (`held + quantity`), so it is the one number in this test that cannot report
        // the write going wrong: a merge that assigned instead of summing — `quantity = ?2`
        // — answers 5 to the caller, moves the note, leaves one row, and puts **three**
        // copies on it. Silent quantity corruption is exactly what the merge rule exists to
        // avoid, so the row is what gets asserted.
        let (quantity, notes): (i64, Option<String>) = conn
            .query_row(
                "SELECT quantity, notes FROM wishlist_entries WHERE id = ?1",
                params![open.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(quantity, 5, "and the row holds what the answer claimed");
        assert_eq!(notes.as_deref(), Some("from the trade binder"));
    }

    /// The merge is on **all four** terms of [`WISHLIST_GRAIN`], the folder included. An
    /// un-pin in `Ordered` does not collide with the open wish at the root, so nothing merges
    /// — and it must not, because merging there would move a filed wish out of the folder the
    /// reader put it in and sum it into a row they were not looking at. The three-term version
    /// of this comparison is the bug `reconcile::fold_wish_into_existing` carried.
    #[test]
    fn set_wish_printing_does_not_merge_across_folders() {
        let conn = seeded();
        folder(&conn, 1, None, "Ordered");
        let at_root = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let filed = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 3,
                folder_id: Some(1),
                ..Default::default()
            },
        )
        .unwrap();

        let after = set_wish_printing(&conn, filed.id, None).unwrap();

        assert_eq!(after.id, filed.id, "the wish stays its own row");
        assert_eq!(after.quantity, 3);
        assert_eq!(wish_count(&conn), 2);
        // Both rows read back from the table, for the sibling merge test's reason and one
        // more: "nothing merged" is a claim about **two** rows, and a version of this that
        // checked only the root one would pass just as happily if the filed wish had been
        // emptied instead of left alone.
        let held = |id: i64| -> (i64, Option<i64>) {
            conn.query_row(
                "SELECT quantity, folder_id FROM wishlist_entries WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(held(at_root.id), (2, None), "the root wish is untouched");
        assert_eq!(
            held(filed.id),
            (3, Some(1)),
            "and the un-pinned one keeps its copies and its folder"
        );
    }

    /// Choosing a printing **is** the review. The only sentences that column carries are the
    /// reconciler's, and both are about an id the row no longer holds once this write lands —
    /// leaving one standing would park a repointed wish behind a complaint about a printing
    /// it is not for. `deck::swap_printing` does not carry the flag across either.
    #[test]
    fn set_wish_printing_clears_needs_review() {
        let conn = seeded();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE wishlist_entries SET needs_review = ?2 WHERE id = ?1",
            params![
                pinned.id,
                "Scryfall removed this printing from its database on 2026-07-01."
            ],
        )
        .unwrap();

        set_wish_printing(&conn, pinned.id, Some("bolt-2ed".into())).unwrap();

        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM wishlist_entries WHERE id = ?1",
                params![pinned.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(review, None);
    }
}
