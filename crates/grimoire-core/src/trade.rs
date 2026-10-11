//! Trades — two lists of cards, what each side is worth, and what happens to the collection
//! and the wishlist when one is finished. User schema v63,
//! [issue #363](https://github.com/Msgaihede/mtg-grimoire/issues/363).
//!
//! [`crate::sticky_notes`]' file shape: pure functions over a [`Connection`], the thirteen
//! commands' bodies and nothing of a window. The wrappers are the desktop host's
//! (`apps/desktop/src-tauri/src/trade/mod.rs`) and the table's (`crate::commands`).
//!
//! # What this module decides, and what it leaves to the page
//!
//! **Rust supplies each line's unit price as a fact and draws no conclusion from it.** A line's
//! value, a side's total, the percentage applied to either and the balance between them are all
//! `packages/ui/features/trade/trade.ts`, in integer cents; nothing here multiplies a price by
//! anything. What this module owns is which figure a line carries — and that turns on one
//! column:
//!
//! * **An open trade is priced live**, in *its own* marketplace (`trades.marketplace`) and not
//!   the reader's current one. [`crate::sorting::price_expr`] is the only spelling of a price in
//!   this crate and it is the one used here.
//! * **A trade that is finished or archived carries the prices it closed with.**
//!   [`finish_trade`] and [`archive_trade`] copy each line's live price into
//!   `trade_lines.unit_price`; [`reopen_trade`] clears the copies. `NULL` on a closed line is a
//!   printing that marketplace did not quote that day, never a zero.
//!
//! `finish_prices` is the exception that proves it: the finish control's hints are *today's*
//! prices whatever the trade's status, because they describe a choice the reader could make now.
//!
//! # One line per printing and finish on a side
//!
//! That is the grain, and it is kept by folding rather than by an index: [`add_trade_lines`]
//! raises the line a side already holds, and an edit that makes a line identical to another on
//! its side ([`update_trade_line`]) takes the other in. See the rung for why no `UNIQUE` backs
//! it.
//!
//! # Only an open trade can be written
//!
//! Every write but [`reopen_trade`], [`duplicate_trade`] and [`delete_trade`] is refused on a
//! trade that is not open, with [`NOT_OPEN`] — a closed trade's lines are a record of what was
//! agreed, and its frozen prices would stop describing them the moment one moved.
//!
//! # A finish is four optional writes and one record of them
//!
//! [`finish_trade`] is the only function here that reaches outside the two trade tables, and it
//! does so through the collection's and the wishlist's own doors. Its four steps and the close
//! are **one savepoint** ([`crate::db::in_savepoint`]), so a refusal half-way — a folder that
//! was deleted under the dialog — leaves the collection, the wishlist and the trade exactly as
//! they were. Each step that moved anything records **one** [`crate::activity`] row, the feed's
//! bulk rule.
//!
//! # Neither table syncs
//!
//! A trade lives on the device that made it (the spec's §6). The collection and wishlist rows a
//! finish writes are captured by those tables' own triggers, as any other write to them is.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::card::FinishPrices;
use crate::schema::FINISHES;
use crate::sorting::{finish_literals, price_expr, Marketplace};

/// The three things a trade can be. `open` is the only one it can be edited in.
pub const STATUSES: [&str; 3] = ["open", "finished", "archived"];
/// `STATUSES[0]` — being built, priced live.
pub const OPEN: &str = STATUSES[0];
/// `STATUSES[1]` — closed by [`finish_trade`], which ran the steps the reader chose.
pub const FINISHED: &str = STATUSES[1];
/// `STATUSES[2]` — closed by [`archive_trade`], which touched nothing but the trade.
pub const ARCHIVED: &str = STATUSES[2];

/// The two sides of a trade, as `trade_lines.side` stores them.
pub const SIDES: [&str; 2] = ["mine", "theirs"];
/// `SIDES[0]` — what the reader gives.
pub const MINE: &str = SIDES[0];
/// `SIDES[1]` — what the reader is given.
pub const THEIRS: &str = SIDES[1];

/// Where a line can have come from, as `trade_lines.source` stores it.
pub const SOURCES: [&str; 3] = ["collection", "search", "scan"];

/// The least a side's percentage of market price can be.
pub const RATE_MIN: i64 = 50;
/// The most.
pub const RATE_MAX: i64 = 150;
/// The step between two percentages — `trade.ts`'s slider snaps to the same one.
pub const RATE_STEP: i64 = 5;

/// What a write says when the trade it names has been deleted — a stale pane, or a second
/// window that removed it.
pub const GONE: &str = "that trade is not there any more";

/// What a write says about a trade that has been finished or archived.
pub const NOT_OPEN: &str = "that trade is no longer open";

/// What an edit says when the line it names has been removed. [`remove_trade_line`] does not say
/// it: a removal that finds nothing already has what it wanted.
pub const LINE_GONE: &str = "that line is not on the trade any more";

/// What a line says when it names a printing the card database does not hold.
pub const NO_SUCH_CARD: &str = "no card with that id is in the card database";

/// What a line says when it asks for no copies. Removing a line is [`remove_trade_line`]'s.
pub const NO_COPIES: &str = "a trade line needs a quantity of at least one";

/// The most copies one line can hold: the ceiling the app's quantity stepper already has
/// (`QuantityStepper`'s `max`), so a figure above it is a caller that did not go through one.
///
/// **It is what keeps `trade_lines.quantity` an integer.** SQLite answers an `i64` overflow in
/// `quantity + ?` with a REAL, a REAL passes `CHECK (quantity > 0)`, and one such row makes
/// [`list_trades`] and [`get_trade`] unreadable for *every* trade — the column is read as an
/// `i64`. So nothing here asks SQL to add two quantities: a sum is formed by [`folded`] and
/// written as a figure.
pub const MAX_QUANTITY: i64 = 9999;

/// What a line says when it is asked to hold more than [`MAX_QUANTITY`] copies — outright, or
/// by a fold that would add two lines up past it.
pub const TOO_MANY: &str = "a trade line holds at most 9999 copies";

/// What [`update_trade_line`] says when the line's printing is not sold in the finish asked for
/// — which is also the answer for a printing that has left the database, whose list of finishes
/// went with it.
pub const FINISH_NOT_SOLD: &str = "that printing does not come in that finish";

/// A new trade. Both fields are optional: a name left out becomes `Trade N`, and a marketplace
/// left out is the reader's current one.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TradeCreate {
    pub name: Option<String>,
    pub marketplace: Option<String>,
}

/// One card going onto a side.
///
/// `#[serde(default)]` although the page always sends all four: a field left out is then an
/// empty string or a zero, and each of those is refused in a sentence about the line rather
/// than as a parse error about the request.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TradeLineInput {
    pub card_id: String,
    pub finish: String,
    pub quantity: i64,
    pub source: String,
}

/// What changes about a line. A field left out is left alone; `side` moves the line across.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TradeLineChange {
    pub card_id: Option<String>,
    pub finish: Option<String>,
    pub quantity: Option<i64>,
    pub side: Option<String>,
}

/// The four questions Finish trade asks. `folder_id` is where received cards are filed, and
/// `None` is the collection's root.
///
/// Every step defaults to **off**, so a request that names none of them closes the trade and
/// touches nothing else — the safe reading of a field a caller forgot.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TradeFinishOptions {
    pub remove_given: bool,
    pub add_received: bool,
    pub folder_id: Option<i64>,
    pub unwish_received: bool,
    pub wish_given: bool,
}

/// What a finish did, in copies — the command's answer, and the JSON `trades.outcome` holds.
///
/// `#[serde(default)]` on the way back in: the column outlives the build that wrote it, and a
/// field a later build adds must read as zero here rather than making a stored outcome
/// unreadable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TradeOutcome {
    /// Every copy a finish took out of the collection, the ones from decks included.
    pub removed_from_collection: i64,
    /// How many of those came out of a deck's group. An outcome stored before the key existed
    /// reads as zero, which is true of it: no finish could reach a deck then.
    pub removed_from_decks: i64,
    pub added_to_collection: i64,
    pub removed_from_wishlist: i64,
    pub added_to_wishlist: i64,
}

impl TradeOutcome {
    /// Two finishes' work, added. A trade finished, reopened and finished again has had both
    /// done to the collection, and the one figure kept on it has to say so.
    ///
    /// Saturating, because the left-hand side is read back out of a column: a stored outcome
    /// is whatever JSON is there, and a finish must not panic over one.
    fn plus(self, other: TradeOutcome) -> TradeOutcome {
        let sum = i64::saturating_add;
        TradeOutcome {
            removed_from_collection: sum(
                self.removed_from_collection,
                other.removed_from_collection,
            ),
            removed_from_decks: sum(self.removed_from_decks, other.removed_from_decks),
            added_to_collection: sum(self.added_to_collection, other.added_to_collection),
            removed_from_wishlist: sum(self.removed_from_wishlist, other.removed_from_wishlist),
            added_to_wishlist: sum(self.added_to_wishlist, other.added_to_wishlist),
        }
    }
}

/// One line of a trade, with the facts the page draws conclusions from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeLine {
    pub id: i64,
    pub side: String,
    pub card_id: String,
    /// `None` when the printing has left `cards`.
    pub oracle_id: Option<String>,
    /// The card's name as `cards` has it, or as the line remembered it when the printing has
    /// left the database — and the same for `set_code` and `collector_number`.
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub layout: Option<String>,
    /// `cards.finishes` as stored: a JSON array, as text.
    pub finishes: Option<String>,
    pub finish: String,
    pub quantity: i64,
    pub source: String,
    /// One copy at 100%, in the trade's marketplace. Live while the trade is open; the figure it
    /// closed with once it is not. `None` is "no price", never zero.
    pub unit_price: Option<f64>,
    /// Today's price of this printing in each finish, whatever the trade's status.
    pub finish_prices: FinishPrices,
    /// Copies of this printing and finish the collection holds **outside any deck**: unfiled, or
    /// in a folder of the reader's own that is not locked. Never a proxy. A finish takes these
    /// first ([`tradeable`]).
    pub owned: i64,
    /// Copies of this printing and finish filed in a **deck's group**. A finish takes them only
    /// once `owned` has run out, and taking one leaves that deck a card short.
    pub owned_in_decks: i64,
    /// The decks those copies sit in, by the name their group wears, in the order a finish
    /// would take from them and each name once.
    pub deck_names: Vec<String>,
    /// Copies of this card on the wishlist, in any printing, outside managed wishlists.
    pub wished: i64,
}

/// A whole trade.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub id: i64,
    pub name: String,
    pub marketplace: String,
    pub rate_mine: i64,
    pub rate_theirs: i64,
    pub status: String,
    /// True once a finish has run, even if the trade was reopened since.
    pub finished_before: bool,
    pub outcome: Option<TradeOutcome>,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub lines: Vec<TradeLine>,
}

/// The little of a line the trades list needs to state a balance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSummaryLine {
    pub side: String,
    pub quantity: i64,
    pub unit_price: Option<f64>,
}

/// One trade in the list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSummary {
    pub id: i64,
    pub name: String,
    pub marketplace: String,
    pub rate_mine: i64,
    pub rate_theirs: i64,
    pub status: String,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub lines: Vec<TradeSummaryLine>,
}

// ---------------------------------------------------------------------------------------
// The shared SQL
// ---------------------------------------------------------------------------------------

/// Where a `collection_entries e` row stands for a trade, with `collection_folders f` joined
/// for its folder: [`OUTSIDE`] any deck — at the collection's root, or in a folder of the
/// reader's own that is not locked — [`IN_DECK`] for a deck's group, and `NULL` for a row a
/// trade neither counts nor takes.
///
/// **A deck's copies can be traded, second and marked.** They were out of reach until
/// 2026-10-11, and on a collection whose cards are mostly sleeved that left a trade almost
/// nothing to offer. So they are counted apart ([`TradeLine::owned_in_decks`]), taken only
/// once the others have run out ([`tradeable_sql`]) and reported apart
/// ([`TradeOutcome::removed_from_decks`]) — which is what lets every surface that shows one
/// say, in the destructive colour, which deck it leaves a card short.
///
/// **A locked folder still holds its copies back; a lock is never asked of a deck's group.**
/// The lock is the reader setting a drawer aside from exactly this kind of offer
/// ([`crate::collection_folders::LOCKED_FOLDER_IDS`], so a folder inside a locked one is locked
/// too). A deck's copies are guarded by the warning instead. **`Recently removed` is `NULL`**:
/// what waits there has left the collection.
///
/// **And never a proxy.** A proxy is a stand-in for the card and not the card: it is not what
/// was agreed across the table, so it is neither counted as owned nor handed over.
///
/// Positive, like the collection page's own fence: a fourth folder kind is `NULL` until
/// somebody decides otherwise.
fn standing() -> String {
    format!(
        "CASE WHEN e.proxy IS NOT 0 THEN NULL
              WHEN e.folder_id IS NULL THEN {OUTSIDE}
              WHEN f.kind = 'deck' THEN {IN_DECK}
              WHEN f.kind = 'user' AND e.folder_id NOT IN ({locked}) THEN {OUTSIDE}
         END",
        locked = crate::collection_folders::LOCKED_FOLDER_IDS
    )
}

/// [`standing`]'s answer for a copy outside any deck.
const OUTSIDE: i64 = 0;
/// [`standing`]'s answer for a copy filed in a deck's group. **Greater than [`OUTSIDE`], and
/// that is the order**: [`tradeable_sql`] sorts on the figure itself.
const IN_DECK: i64 = 1;

/// Whether a `collection_entries e` row is a copy unlike the others of its printing and finish:
/// **graded, signed, altered, a misprint, or carrying a serial number** — the five terms of the
/// collection's grain that say something about one physical object. `1` for such a row, `0` for
/// a plain one.
///
/// `coalesce(…, '')` on the two text columns, as [`crate::schema::COLLECTION_GRAIN`] spells
/// them: `''` and `NULL` are both "none". Condition, language and what the row cost are not
/// here — a played copy is still an ordinary one.
const SPECIAL: &str = "(e.altered <> 0 OR e.signed <> 0 OR e.misprint <> 0
          OR coalesce(e.serial_number, '') <> '' OR coalesce(e.grading, '') <> '')";

/// Every collection row a trade may take copies of one printing and finish from (`?1`, `?2`),
/// **in the order it takes them**: the row, its copies, its folder's name and its
/// [`standing`].
///
/// **One statement for the count and the take.** [`TradeLine::owned`],
/// [`TradeLine::owned_in_decks`] and [`TradeLine::deck_names`] are what the dialog promises and
/// [`take_given`] is what the press does, and all four read [`tradeable`] — so the numbers on
/// screen and the copies taken cannot come apart, and neither can the order the decks are named
/// in and the order they are emptied in.
///
/// # The order
///
/// **Every copy outside a deck before any copy in one.** A deck's copy is the one whose leaving
/// costs something the trade never mentioned, so it goes last — after a signed copy in a binder,
/// too: the reader was shown both figures and asked for that many.
///
/// **Then plain copies before [`SPECIAL`] ones.** A line names a printing and a finish and
/// nothing more, so a trade giving one foil Bolt must not delete the reader's signed one — with
/// its purchase price and its notes, and with no undo — while three plain foil Bolts sit beside
/// it. A special copy still goes once the plain ones have run out.
///
/// Then **root rows before folders**, folders in the order the reader arranged them and the
/// oldest row first — a copy nobody filed is the one whose leaving disturbs no decision,
/// `deck_pull`'s ranking. A deck's group is a folder like any other here; every group is made
/// at `sort_order` 0, so among decks it is the oldest row that goes first.
fn tradeable_sql() -> String {
    let standing = standing();
    format!(
        "SELECT e.id, e.quantity, f.name, {standing} AS standing
           FROM collection_entries e
           LEFT JOIN collection_folders f ON f.id = e.folder_id
          WHERE e.card_id = ?1 AND e.finish = ?2 AND e.quantity > 0
            AND {standing} IS NOT NULL
          ORDER BY standing, {SPECIAL}, (e.folder_id IS NOT NULL), f.sort_order, e.id"
    )
}

/// One collection row a trade may take copies from — a row of [`tradeable_sql`].
struct Copies {
    entry: i64,
    quantity: i64,
    /// The folder's name, and `None` for the root. **For a row in a deck's group it is the
    /// deck's name**: `deck::update_deck` renames the group with the deck, and it is the name
    /// the collection's own cabinet draws.
    folder: Option<String>,
    in_deck: bool,
}

/// The rows a trade may take copies of `card_id` in `finish` from, in the order it takes them.
fn tradeable(conn: &Connection, card_id: &str, finish: &str) -> Result<Vec<Copies>, String> {
    let mut stmt = conn
        .prepare_cached(&tradeable_sql())
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![card_id, finish], |r| {
            Ok(Copies {
                entry: r.get(0)?,
                quantity: r.get(1)?,
                folder: r.get(2)?,
                in_deck: r.get::<_, i64>(3)? == IN_DECK,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// What a line says about the collection: [`tradeable`]'s rows, added up either side of the
/// deck line. Saturating, [`copies_of`]'s reason — the figures are read out of a table.
struct Held {
    owned: i64,
    in_decks: i64,
    deck_names: Vec<String>,
}

fn held(copies: &[Copies]) -> Held {
    let mut held = Held {
        owned: 0,
        in_decks: 0,
        deck_names: Vec::new(),
    };
    for row in copies {
        if !row.in_deck {
            held.owned = held.owned.saturating_add(row.quantity);
            continue;
        }
        held.in_decks = held.in_decks.saturating_add(row.quantity);
        // By name, because a name is all the page is given: two decks that share one are one
        // entry in the sentence that warns about them.
        if let Some(name) = row
            .folder
            .as_ref()
            .filter(|n| !held.deck_names.contains(*n))
        {
            held.deck_names.push(name.clone());
        }
    }
    held
}

/// Which `wishlist_entries w` rows are wishes for the card `card` is a printing of, with
/// `wishlist_folders wf` joined for the wish's folder.
///
/// `crate::deck_quick_add`'s `CARD_WISH_SQL` in shape: the wish names this printing, or its
/// oracle card is this printing's — so a wish pinned to another printing counts, and a printing
/// that has left `cards` still finds the wishes naming it by id. **Never a managed wishlist's
/// wish**, which is its deck's and rewritten by [`crate::managed_wishlist`].
///
/// One spelling for the count and the take, [`tradeable_sql`]'s reason: [`TradeLine::wished`] and
/// [`unwish_received`] both read it.
fn wish_for(card: &str) -> String {
    format!(
        "(w.card_id = {card}
          OR (w.oracle_id IS NOT NULL
              AND w.oracle_id = (SELECT k.oracle_id FROM cards k WHERE k.id = {card})))
         AND wf.managed_deck_id IS NULL"
    )
}

/// What a line's `unit_price` column is: the live price while the trade is open, the frozen
/// copy once it is not.
fn unit_price_sql(market: Marketplace, open: bool) -> String {
    if open {
        price_expr(market, "l.finish")
    } else {
        "l.unit_price".to_owned()
    }
}

/// A trade's lines in full, in the order a side is read in.
///
/// `LEFT JOIN cards`, and that is the point of the three denormalised columns: a line whose
/// printing a sync has dropped still lists, under the name it was written with and with no
/// price.
///
/// **What the collection holds of a line is not a column here.** [`get_trade`] asks
/// [`tradeable`] per line, the statement a finish takes from — a sum spelled a second time in
/// this one would be a second answer to keep in step.
fn lines_sql(market: Marketplace, open: bool) -> String {
    let [nonfoil, foil, etched] = finish_literals().map(|finish| price_expr(market, &finish));
    format!(
        "SELECT l.id, l.side, l.card_id, c.oracle_id,
                coalesce(c.name, l.name), coalesce(c.set_code, l.set_code), c.set_name,
                coalesce(c.collector_number, l.collector_number), c.rarity, c.layout,
                c.finishes, l.finish, l.quantity, l.source,
                {unit},
                {nonfoil}, {foil}, {etched},
                coalesce((SELECT sum(w.quantity) FROM wishlist_entries w
                            LEFT JOIN wishlist_folders wf ON wf.id = w.folder_id
                           WHERE {wished}), 0)
           FROM trade_lines l
           LEFT JOIN cards c ON c.id = l.card_id
          WHERE l.trade_id = ?1
          ORDER BY l.position, l.id",
        unit = unit_price_sql(market, open),
        wished = wish_for("l.card_id"),
    )
}

/// The three columns the trades list needs of each line.
fn summary_lines_sql(market: Marketplace, open: bool) -> String {
    format!(
        "SELECT l.side, l.quantity, {unit}
           FROM trade_lines l
           LEFT JOIN cards c ON c.id = l.card_id
          WHERE l.trade_id = ?1
          ORDER BY l.position, l.id",
        unit = unit_price_sql(market, open),
    )
}

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

/// A `trades` row, as the writes need it.
struct Header {
    name: String,
    marketplace: String,
    rate_mine: i64,
    rate_theirs: i64,
    status: String,
    finished_before: bool,
    outcome: Option<TradeOutcome>,
    created_at: i64,
    closed_at: Option<i64>,
}

impl Header {
    fn market(&self) -> Marketplace {
        Marketplace::from_id(&self.marketplace)
    }

    fn open(&self) -> bool {
        self.status == OPEN
    }
}

/// The trade's row, or `None` when there is no such trade.
///
/// `outcome` is parsed here and an unreadable one is `None`: the column is this module's own
/// JSON and nothing a reader can repair, so a damaged one costs the archive its sentence about
/// the finish rather than the trade its page.
fn header(conn: &Connection, id: i64) -> Result<Option<Header>, String> {
    conn.query_row(
        "SELECT name, marketplace, rate_mine, rate_theirs, status, finished_before, outcome,
                created_at, closed_at
           FROM trades WHERE id = ?1",
        params![id],
        |r| {
            let outcome: Option<String> = r.get(6)?;
            Ok(Header {
                name: r.get(0)?,
                marketplace: r.get(1)?,
                rate_mine: r.get(2)?,
                rate_theirs: r.get(3)?,
                status: r.get(4)?,
                finished_before: r.get(5)?,
                outcome: outcome.and_then(|text| serde_json::from_str(&text).ok()),
                created_at: r.get(7)?,
                closed_at: r.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The trade, for a write that needs it open: [`GONE`] when it is not there, [`NOT_OPEN`] when
/// it has been finished or archived.
fn open_trade(conn: &Connection, id: i64) -> Result<Header, String> {
    let trade = header(conn, id)?.ok_or_else(|| GONE.to_owned())?;
    if !trade.open() {
        return Err(NOT_OPEN.to_owned());
    }
    Ok(trade)
}

/// Every trade, newest first, each with just enough of its lines to state a balance.
///
/// **One lines query per trade, and not one join over all of them**, because the price
/// expression is the trade's *own* marketplace's and so differs from row to row — a single
/// statement would have to carry all four spellings and pick between them per line. A reader has
/// tens of trades; the statements are cached, so there are at most five to prepare (four
/// marketplaces live, and the frozen column).
pub fn list_trades(conn: &Connection) -> Result<Vec<TradeSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, marketplace, rate_mine, rate_theirs, status, created_at, closed_at
               FROM trades
              ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let mut trades = stmt
        .query_map([], |r| {
            Ok(TradeSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                marketplace: r.get(2)?,
                rate_mine: r.get(3)?,
                rate_theirs: r.get(4)?,
                status: r.get(5)?,
                created_at: r.get(6)?,
                closed_at: r.get(7)?,
                lines: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for trade in &mut trades {
        let sql = summary_lines_sql(
            Marketplace::from_id(&trade.marketplace),
            trade.status == OPEN,
        );
        let mut lines = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        trade.lines = lines
            .query_map(params![trade.id], |r| {
                Ok(TradeSummaryLine {
                    side: r.get(0)?,
                    quantity: r.get(1)?,
                    unit_price: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
    }
    Ok(trades)
}

/// One trade with its lines, or `None` when it is gone.
pub fn get_trade(conn: &Connection, id: i64) -> Result<Option<Trade>, String> {
    let Some(trade) = header(conn, id)? else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare_cached(&lines_sql(trade.market(), trade.open()))
        .map_err(|e| e.to_string())?;
    let mut lines = stmt
        .query_map(params![id], |r| {
            Ok(TradeLine {
                id: r.get(0)?,
                side: r.get(1)?,
                card_id: r.get(2)?,
                oracle_id: r.get(3)?,
                name: r.get(4)?,
                set_code: r.get(5)?,
                set_name: r.get(6)?,
                collector_number: r.get(7)?,
                rarity: r.get(8)?,
                layout: r.get(9)?,
                finishes: r.get(10)?,
                finish: r.get(11)?,
                quantity: r.get(12)?,
                source: r.get(13)?,
                unit_price: r.get(14)?,
                finish_prices: FinishPrices {
                    nonfoil: r.get(15)?,
                    foil: r.get(16)?,
                    etched: r.get(17)?,
                },
                // The three the collection answers, filled in below.
                owned: 0,
                owned_in_decks: 0,
                deck_names: Vec::new(),
                wished: r.get(18)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for line in &mut lines {
        let held = held(&tradeable(conn, &line.card_id, &line.finish)?);
        line.owned = held.owned;
        line.owned_in_decks = held.in_decks;
        line.deck_names = held.deck_names;
    }
    Ok(Some(Trade {
        id,
        name: trade.name,
        marketplace: trade.marketplace,
        rate_mine: trade.rate_mine,
        rate_theirs: trade.rate_theirs,
        status: trade.status,
        finished_before: trade.finished_before,
        outcome: trade.outcome,
        created_at: trade.created_at,
        closed_at: trade.closed_at,
        lines,
    }))
}

// ---------------------------------------------------------------------------------------
// The words a write is checked against
// ---------------------------------------------------------------------------------------

fn valid_side(side: &str) -> Result<&'static str, String> {
    SIDES
        .into_iter()
        .find(|known| *known == side)
        .ok_or_else(|| format!("`{side}` is not a side of a trade"))
}

fn valid_finish(finish: &str) -> Result<&'static str, String> {
    FINISHES
        .into_iter()
        .find(|known| *known == finish)
        .ok_or_else(|| format!("`{finish}` is not a finish this app knows"))
}

fn valid_source(source: &str) -> Result<&'static str, String> {
    SOURCES
        .into_iter()
        .find(|known| *known == source)
        .ok_or_else(|| format!("`{source}` is not somewhere a trade line can come from"))
}

/// A quantity a line can be asked to hold: at least one copy ([`NO_COPIES`]) and at most
/// [`MAX_QUANTITY`] ([`TOO_MANY`]).
fn valid_copies(quantity: i64) -> Result<i64, String> {
    if quantity <= 0 {
        return Err(NO_COPIES.to_owned());
    }
    if quantity > MAX_QUANTITY {
        return Err(TOO_MANY.to_owned());
    }
    Ok(quantity)
}

/// Two quantities as one line's — what a fold leaves — or [`TOO_MANY`].
///
/// **The sum is formed here and never in SQL** ([`MAX_QUANTITY`] has why), and it is checked:
/// `held` was read out of a column, so nothing about it is promised.
fn folded(held: i64, more: i64) -> Result<i64, String> {
    held.checked_add(more)
        .filter(|sum| *sum <= MAX_QUANTITY)
        .ok_or_else(|| TOO_MANY.to_owned())
}

/// The marketplace a new trade is priced in: the one asked for, or the reader's current one.
///
/// **Always one of the four that quote a price.** `cardtrader` is a marketplace the setting
/// knows and no feed serves — [`Marketplace::from_id`] already reads it as TCGplayer — so a
/// trade made under it is stored as the marketplace its figures actually are, and the page's
/// *prices from …* line names the right one. An id this build has never heard of is refused
/// rather than read as the default: a trade that silently changed currency is the worse failure.
fn marketplace_for(conn: &Connection, asked: &Option<String>) -> Result<String, String> {
    let id = match crate::filters::nonblank(asked) {
        Some(id) if crate::marketplace::is_known(id) => id.to_owned(),
        Some(id) => return Err(format!("`{id}` is not a marketplace this app knows")),
        None => crate::marketplace::stored(conn),
    };
    // The four priced ids are the picker's first four, in `Marketplace`'s own order.
    if crate::marketplace::MARKETPLACE_IDS[..4].contains(&id.as_str()) {
        Ok(id)
    } else {
        Ok(crate::marketplace::DEFAULT_MARKETPLACE.to_owned())
    }
}

/// What a line remembers of its printing, and the finishes that printing is sold in.
struct Printing {
    name: String,
    set_code: String,
    collector_number: String,
    /// `cards.finishes` read as words this app knows, in the order Scryfall lists them. Empty
    /// for a printing whose list is missing or unreadable.
    finishes: Vec<String>,
}

/// The printing `card_id` names, or `None` when `cards` holds no such row.
fn printing(conn: &Connection, card_id: &str) -> Result<Option<Printing>, String> {
    conn.query_row(
        "SELECT name, set_code, collector_number, finishes FROM cards WHERE id = ?1",
        params![card_id],
        |r| {
            let finishes: Option<String> = r.get(3)?;
            Ok(Printing {
                name: r.get(0)?,
                set_code: r.get(1)?,
                collector_number: r.get(2)?,
                finishes: finishes
                    .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|word| FINISHES.contains(&word.as_str()))
                    .collect(),
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Where the next line of a trade goes: after every line it has, on either side.
fn next_position(conn: &Connection, trade_id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT coalesce(max(position), -1) + 1 FROM trade_lines WHERE trade_id = ?1",
        params![trade_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// The line a side already holds for a printing and finish, other than `except`.
fn twin(
    conn: &Connection,
    trade_id: i64,
    side: &str,
    card_id: &str,
    finish: &str,
    except: Option<i64>,
) -> Result<Option<(i64, i64)>, String> {
    conn.query_row(
        "SELECT id, quantity FROM trade_lines
          WHERE trade_id = ?1 AND side = ?2 AND card_id = ?3 AND finish = ?4
            AND id IS NOT ?5
          ORDER BY position, id LIMIT 1",
        params![trade_id, side, card_id, finish, except],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Writes to the trade itself
// ---------------------------------------------------------------------------------------

/// Make a trade and answer its id.
///
/// **A name left out, or blank, is `Trade N`** — N the trade's own id, which is why this is an
/// insert and an update in one savepoint rather than one statement: the id is not known until
/// the row exists.
pub fn create_trade(conn: &Connection, trade: &TradeCreate) -> Result<i64, String> {
    let marketplace = marketplace_for(conn, &trade.marketplace)?;
    let name = crate::filters::nonblank(&trade.name).unwrap_or_default();
    crate::db::in_savepoint(conn, "trade_create", || {
        let id: i64 = conn
            .query_row(
                "INSERT INTO trades (name, marketplace, created_at)
                 VALUES (?1, ?2, unixepoch()) RETURNING id",
                params![name, marketplace],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if name.is_empty() {
            conn.execute(
                "UPDATE trades SET name = 'Trade ' || id WHERE id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(id)
    })
}

/// Rename an open trade. A blank name is the one it would have been made with, `Trade N`:
/// clearing the field is how a reader asks for the default back, and a trade with no name at all
/// is a row in the list nobody can press.
pub fn rename_trade(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    open_trade(conn, id)?;
    let name = match name.trim() {
        "" => format!("Trade {id}"),
        named => named.to_owned(),
    };
    conn.execute(
        "UPDATE trades SET name = ?2 WHERE id = ?1",
        params![id, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Set one side's percentage of market price: [`RATE_MIN`] to [`RATE_MAX`] in steps of
/// [`RATE_STEP`], and anything else is refused rather than snapped — the page's slider snaps,
/// so a figure off the grid is a caller that did not, and rounding it here would store a number
/// nobody chose.
pub fn set_trade_rate(conn: &Connection, id: i64, side: &str, rate: i64) -> Result<(), String> {
    open_trade(conn, id)?;
    let side = valid_side(side)?;
    if !(RATE_MIN..=RATE_MAX).contains(&rate) || rate % RATE_STEP != 0 {
        return Err(format!(
            "a side's percentage is {RATE_MIN} to {RATE_MAX} in steps of {RATE_STEP}"
        ));
    }
    // The column is chosen from the two this module spells, never from the argument.
    let column = if side == MINE {
        "rate_mine"
    } else {
        "rate_theirs"
    };
    conn.execute(
        &format!("UPDATE trades SET {column} = ?2 WHERE id = ?1"),
        params![id, rate],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Put cards on a side of an open trade.
///
/// **A printing and finish the side already holds raises that line** rather than making a
/// second one, and the line keeps the source it was first added with. Two inputs naming the
/// same printing and finish fold the same way, because the second finds the first.
///
/// **All or nothing**: one savepoint, so a refused line — no copies or too many, a finish or a
/// source that is not a word, a printing the database does not hold — leaves the side as it
/// was. A scan that put eleven cards on and dropped the twelfth would be a list the reader has
/// to audit.
///
/// **[`MAX_QUANTITY`] bounds the line and not the input alone**: a quantity that fits is still
/// refused ([`TOO_MANY`]) when the line it would raise cannot take it, and that refusal takes
/// the batch back with it like any other.
///
/// The finish is checked as a word and **not** against the printing's own list, where
/// [`update_trade_line`] does check: a line arrives from the collection or the scanner in the
/// finish a real copy is in, and the collection can hold a finish `cards.finishes` does not
/// list (an import says what it says).
pub fn add_trade_lines(
    conn: &Connection,
    id: i64,
    side: &str,
    lines: &[TradeLineInput],
) -> Result<(), String> {
    crate::db::in_savepoint(conn, "trade_add_lines", || {
        open_trade(conn, id)?;
        let side = valid_side(side)?;
        for line in lines {
            let finish = valid_finish(&line.finish)?;
            let source = valid_source(&line.source)?;
            let quantity = valid_copies(line.quantity)?;
            let card = printing(conn, &line.card_id)?.ok_or_else(|| NO_SUCH_CARD.to_owned())?;
            match twin(conn, id, side, &line.card_id, finish, None)? {
                Some((standing, held)) => conn.execute(
                    "UPDATE trade_lines SET quantity = ?2 WHERE id = ?1",
                    params![standing, folded(held, quantity)?],
                ),
                None => conn.execute(
                    "INSERT INTO trade_lines
                        (trade_id, side, card_id, name, set_code, collector_number, finish,
                         quantity, source, position)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        id,
                        side,
                        line.card_id,
                        card.name,
                        card.set_code,
                        card.collector_number,
                        finish,
                        quantity,
                        source,
                        next_position(conn, id)?,
                    ],
                ),
            }
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// A `trade_lines` row, as an edit needs it.
struct LineRow {
    trade_id: i64,
    side: String,
    card_id: String,
    name: String,
    set_code: String,
    collector_number: String,
    finish: String,
    quantity: i64,
    position: i64,
}

fn line_row(conn: &Connection, line_id: i64) -> Result<Option<LineRow>, String> {
    conn.query_row(
        "SELECT trade_id, side, card_id, name, set_code, collector_number, finish, quantity,
                position
           FROM trade_lines WHERE id = ?1",
        params![line_id],
        |r| {
            Ok(LineRow {
                trade_id: r.get(0)?,
                side: r.get(1)?,
                card_id: r.get(2)?,
                name: r.get(3)?,
                set_code: r.get(4)?,
                collector_number: r.get(5)?,
                finish: r.get(6)?,
                quantity: r.get(7)?,
                position: r.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Change a line's printing, finish, quantity or side. A field left out is left alone.
///
/// # The rules, in the order they are applied
///
/// 1. **The printing.** A new one must be in the card database ([`NO_SUCH_CARD`]), and the line
///    takes its name, set and number. **The finish follows it**: kept when the new printing is
///    sold in it, and otherwise the new printing's first listed finish — a foil line repointed
///    at a printing that only exists nonfoil becomes a nonfoil line, rather than a line for an
///    object nobody can hand over.
/// 2. **The finish**, when one is named: refused with [`FINISH_NOT_SOLD`] unless the line's
///    printing — the new one, if step 1 changed it — is sold in it. Naming the finish the line
///    already has changes nothing and is not checked, so an edit that only moves a quantity on
///    a line the collection supplied in an unlisted finish still lands.
/// 3. **The quantity**: zero or less is refused ([`NO_COPIES`]), and so is more than
///    [`MAX_QUANTITY`] ([`TOO_MANY`]). Taking a line off a trade is [`remove_trade_line`]'s,
///    and an edit that deleted would make a mistyped `0` destructive.
/// 4. **The side**: a line moved across goes to the end of the trade's order.
/// 5. **The fold.** If the side now holds another line for the same printing and finish, the
///    two become one: **the edited line keeps its place** and takes the other's copies, and the
///    other is deleted. That is [`add_trade_lines`]'s grain, kept from the other direction —
///    and its ceiling: two lines that add up past [`MAX_QUANTITY`] are refused ([`TOO_MANY`])
///    rather than folded, whether or not the edit named a quantity.
///
/// One savepoint, so a refusal at any step writes nothing.
pub fn update_trade_line(
    conn: &Connection,
    line_id: i64,
    change: &TradeLineChange,
) -> Result<(), String> {
    crate::db::in_savepoint(conn, "trade_update_line", || {
        let mut line = line_row(conn, line_id)?.ok_or_else(|| LINE_GONE.to_owned())?;
        open_trade(conn, line.trade_id)?;

        // 1 — the printing, and the finish it leaves the line in.
        let asked_card = crate::filters::nonblank(&change.card_id).filter(|id| *id != line.card_id);
        let mut repointed = None;
        if let Some(card_id) = asked_card {
            let card = printing(conn, card_id)?.ok_or_else(|| NO_SUCH_CARD.to_owned())?;
            if !card.finishes.contains(&line.finish) {
                if let Some(first) = card.finishes.first() {
                    line.finish = first.clone();
                }
            }
            line.card_id = card_id.to_owned();
            line.name = card.name.clone();
            line.set_code = card.set_code.clone();
            line.collector_number = card.collector_number.clone();
            repointed = Some(card);
        }

        // 2 — a finish the reader named.
        if let Some(asked) = change.finish.as_deref() {
            let finish = valid_finish(asked)?;
            if finish != line.finish {
                let sold = match &repointed {
                    Some(card) => card.finishes.iter().any(|f| f == finish),
                    None => printing(conn, &line.card_id)?
                        .is_some_and(|card| card.finishes.iter().any(|f| f == finish)),
                };
                if !sold {
                    return Err(FINISH_NOT_SOLD.to_owned());
                }
                line.finish = finish.to_owned();
            }
        }

        // 3 — the quantity.
        if let Some(quantity) = change.quantity {
            line.quantity = valid_copies(quantity)?;
        }

        // 4 — the side.
        if let Some(asked) = change.side.as_deref() {
            let side = valid_side(asked)?;
            if side != line.side {
                line.side = side.to_owned();
                line.position = next_position(conn, line.trade_id)?;
            }
        }

        // 5 — the fold, before the write that would make the two rows identical.
        if let Some((other, held)) = twin(
            conn,
            line.trade_id,
            &line.side,
            &line.card_id,
            &line.finish,
            Some(line_id),
        )? {
            line.quantity = folded(line.quantity, held)?;
            conn.execute("DELETE FROM trade_lines WHERE id = ?1", params![other])
                .map_err(|e| e.to_string())?;
        }

        conn.execute(
            "UPDATE trade_lines
                SET side = ?2, card_id = ?3, name = ?4, set_code = ?5, collector_number = ?6,
                    finish = ?7, quantity = ?8, position = ?9
              WHERE id = ?1",
            params![
                line_id,
                line.side,
                line.card_id,
                line.name,
                line.set_code,
                line.collector_number,
                line.finish,
                line.quantity,
                line.position,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Take a line off an open trade.
///
/// **A line that is already gone is a success**, `collection::remove_entry`'s rule: the caller
/// with a stale id is a list still holding a row something else removed, and it already has
/// what it asked for. A line on a closed trade is still refused — that one is there, and may not
/// be touched.
pub fn remove_trade_line(conn: &Connection, line_id: i64) -> Result<(), String> {
    let Some(line) = line_row(conn, line_id)? else {
        return Ok(());
    };
    open_trade(conn, line.trade_id)?;
    conn.execute("DELETE FROM trade_lines WHERE id = ?1", params![line_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Closing, reopening, copying and deleting
// ---------------------------------------------------------------------------------------

/// Copy every line's live price into the line — what makes a closed trade keep its figures.
///
/// The same [`price_expr`] the open trade was drawn with, at the same marketplace, so the
/// number frozen is the number that was on screen. A printing that has left `cards` matches no
/// row and freezes `NULL`, which is what it was showing.
fn freeze_prices(conn: &Connection, id: i64, market: Marketplace) -> Result<(), String> {
    conn.execute(
        &format!(
            "UPDATE trade_lines AS l
                SET unit_price = (SELECT {price} FROM cards c WHERE c.id = l.card_id)
              WHERE l.trade_id = ?1",
            price = price_expr(market, "l.finish")
        ),
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One line of a trade being finished: what each of the four steps needs and no more.
struct Closing {
    side: String,
    card_id: String,
    /// The card's name for the feed — `cards`' when the printing is still there, the line's own
    /// when it is not.
    name: String,
    finish: String,
    quantity: i64,
    /// Whether `cards` still holds the printing. The two steps that *add* a row need it to; the
    /// two that take copies away do not.
    known: bool,
}

fn closing_lines(conn: &Connection, id: i64) -> Result<Vec<Closing>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.side, l.card_id, coalesce(c.name, l.name), l.finish, l.quantity,
                    c.id IS NOT NULL
               FROM trade_lines l
               LEFT JOIN cards c ON c.id = l.card_id
              WHERE l.trade_id = ?1
              ORDER BY l.position, l.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok(Closing {
                side: r.get(0)?,
                card_id: r.get(1)?,
                name: r.get(2)?,
                finish: r.get(3)?,
                quantity: r.get(4)?,
                known: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// What one line contributed to a finish step: the card, and the copies the step moved for it.
struct Moved<'a> {
    line: &'a Closing,
    copies: i64,
    /// The one folder every copy came out of, for a step that ends up being about one card.
    /// `None` for the root, and for copies drawn from more than one place.
    folder: Option<String>,
}

/// The copies a step moved, across every line it touched.
///
/// Saturating: a line holds at most [`MAX_QUANTITY`], but the figures are read out of a table,
/// and a count for the feed is not worth a panic in a debug build.
fn copies_of(moved: &[Moved<'_>]) -> i64 {
    moved
        .iter()
        .fold(0, |copies: i64, m| copies.saturating_add(m.copies))
}

/// Write a finish step's one feed row — or none, when the step moved nothing.
///
/// **A step about one card reads as that card's own line** (`lone`: the kind and payload the
/// collection or the wishlist writes for a single press), `collection::remove_entries`' rule: a
/// one-card run is the same event as the row menu's and must read as one. **A step about
/// several is one row naming no card** (`run`), with its count in the payload — the feed's bulk
/// rule. The table's CHECK admits no kind of its own for a trade, so a run borrows `remove`,
/// `import` or `clear` and carries `trade: true`, which is the one key `activityText.ts` reads to
/// say *Traded away*, *Received … in a trade* and *Took … off your wishlist after a trade* rather
/// than naming a press the reader never made.
///
/// `sign` is `1` for copies that arrived and `-1` for copies that left, so `delta` sums into the
/// day header like every other row's.
fn record_step(
    conn: &Connection,
    scope: &str,
    moved: &[Moved<'_>],
    lone: (&str, serde_json::Value),
    run: (&str, serde_json::Value),
    sign: i64,
) -> Result<(), String> {
    let (kind, card, payload) = match moved {
        [] => return Ok(()),
        [one] => (lone.0, Some(one.line), lone.1),
        _ => (run.0, None, run.1),
    };
    crate::activity::record(
        conn,
        scope,
        kind,
        card.map(|line| line.card_id.as_str()),
        card.map(|line| line.name.as_str()),
        &payload,
        sign.saturating_mul(copies_of(moved)),
    )
    .map_err(|e| e.to_string())
}

/// The one place every member of `places` agrees on, or `None`.
fn only_place(places: &[Option<String>]) -> Option<String> {
    match places {
        [first, rest @ ..] if rest.iter().all(|place| place == first) => first.clone(),
        _ => None,
    }
}

/// What step 1 took: every copy, and how many of them came out of a deck's group.
struct Given {
    copies: i64,
    from_decks: i64,
}

/// Step 1 — take the cards the reader gave out of the collection. Answers the copies taken.
///
/// **Only what the collection holds, and only [`tradeable`]'s rows, in its order**: every copy
/// outside a deck first — plain before graded, signed, altered, misprinted or serial-numbered,
/// root before folders — and a deck's copies only for what is still owed after those. A line
/// for three of a card the reader holds two of takes two and leaves the line alone, and a line
/// the copies outside cover leaves every deck as it was; the dialog said both before the press.
///
/// A row taken down to nothing is deleted, `collection::set_quantity`'s rule since schema v24.
/// **One that keeps copies has its tradelist spent, not clamped**: the copies that left in a
/// trade are the ones the tradelist was promising, so it falls by the copies taken and stops at
/// nothing. `set_quantity`'s `min(tradelist, quantity)` is the wrong rule here — a row of four
/// with two for trade that gives two would end with both of the copies the reader kept still
/// on offer. Silent per row — the feed row is the step's, written once.
///
/// # A copy out of a deck's group is the same two statements, and nothing about the deck
///
/// That is the collection's own removal, read on 2026-10-11: `set_quantity`, `remove_entry`
/// and `delete_entry` ask nothing about where a row is filed, and write no `deck_cards` row,
/// no `deck_audit` row and no allocation for one in a group. A deck's owned count is a sum
/// over its group at read time, so the deck keeps the card on its list and reads it as not
/// owned — *a deck that wants cards it does not currently hold*, the state
/// `docs/reference/collection-folders.md` calls honest and representable. `collection_alloc`
/// taking a card off the other deck's list is a different act: a *move* into another deck,
/// where the copies are still the reader's.
fn take_given(conn: &Connection, lines: &[Closing]) -> Result<Given, String> {
    let mut moved = Vec::new();
    let mut from_decks: i64 = 0;
    for line in lines.iter().filter(|line| line.side == MINE) {
        let mut left = line.quantity;
        let mut places = Vec::new();
        for row in tradeable(conn, &line.card_id, &line.finish)? {
            if left == 0 {
                break;
            }
            let take = left.min(row.quantity);
            if take >= row.quantity {
                crate::collection::delete_entry(conn, row.entry)?;
            } else {
                // Every right-hand side reads the row as it was. The inner `min` is the
                // column's standing promise — never more for trade than there are — kept
                // against a row that arrived already breaking it.
                conn.execute(
                    "UPDATE collection_entries
                        SET quantity = quantity - ?2,
                            tradelist_quantity =
                                max(0, min(tradelist_quantity - ?2, quantity - ?2)),
                            updated_at = unixepoch()
                      WHERE id = ?1",
                    params![row.entry, take],
                )
                .map_err(|e| e.to_string())?;
            }
            left -= take;
            if row.in_deck {
                from_decks = from_decks.saturating_add(take);
            }
            places.push(row.folder);
        }
        if left < line.quantity {
            moved.push(Moved {
                line,
                copies: line.quantity - left,
                folder: only_place(&places),
            });
        }
    }
    let folder = moved.first().and_then(|m| m.folder.clone());
    record_step(
        conn,
        crate::activity::COLLECTION,
        &moved,
        (crate::activity::REMOVE, json!({ "folder": folder })),
        (
            crate::activity::REMOVE,
            json!({ "entries": moved.len(), "trade": true }),
        ),
        -1,
    )?;
    Ok(Given {
        copies: copies_of(&moved),
        from_decks,
    })
}

/// Step 2 — add the cards the reader received to the collection, in `folder_id` (`None` is the
/// root). Answers the copies added.
///
/// Through [`crate::collection::add_entry_filed`] with the reader's own fence
/// ([`crate::collection::READER_FOLDERS`]), so every rule an ordinary add keeps is kept here —
/// the grain it folds on, the folder refused when it is gone or is not the reader's — and a
/// refusal takes the whole finish back with it.
///
/// **A line whose printing has left the card database is skipped**, not refused: the collection
/// cannot record a printing it cannot name, the outcome counts what was actually added, and
/// refusing would leave a trade that can never be finished with this box ticked.
///
/// **Several cards are recorded as the feed's `import` row** — the scanner tray's precedent
/// (`scanner::commit_tray`), and the one sentence `activityText.ts` has for a run of cards
/// arriving in the collection at once. One card is an ordinary `add`.
fn add_received(
    conn: &Connection,
    lines: &[Closing],
    folder_id: Option<i64>,
) -> Result<i64, String> {
    let mut moved = Vec::new();
    for line in lines
        .iter()
        .filter(|line| line.side == THEIRS && line.known)
    {
        let input = crate::collection::EntryInput {
            card_id: line.card_id.clone(),
            finish: line.finish.clone(),
            quantity: line.quantity,
            folder_id,
            ..Default::default()
        };
        crate::collection::add_entry_filed(conn, &input, crate::collection::READER_FOLDERS)?;
        moved.push(Moved {
            line,
            copies: line.quantity,
            folder: None,
        });
    }
    // The folder by name, because the feed outlives the folder — and only when there is a row to
    // put it in. `None` is the root, which draws no clause.
    let folder: Option<String> = match folder_id {
        Some(folder) if !moved.is_empty() => conn
            .query_row(
                "SELECT name FROM collection_folders WHERE id = ?1",
                params![folder],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        _ => None,
    };
    let finish = moved.first().map(|m| m.line.finish.as_str());
    let copies = copies_of(&moved);
    record_step(
        conn,
        crate::activity::COLLECTION,
        &moved,
        (
            crate::activity::ADD,
            json!({ "folder": folder, "finish": finish }),
        ),
        (
            crate::activity::IMPORT,
            json!({ "cards": copies, "rows": moved.len(), "trade": true }),
        ),
        1,
    )?;
    Ok(copies)
}

/// Step 3 — take the cards the reader received off the wishlist. Answers the copies taken.
///
/// For each line, up to its quantity, off the wishes for that **card** ([`wish_for`]): the wish
/// for this exact printing first, then one whose finish these copies satisfy, then the root
/// before the reader's folders — `deck_quick_add`'s pre-pick order, walked instead of offered,
/// because a trade of eight cards cannot ask eight questions. A wish taken down to nothing is
/// deleted ([`crate::deck_quick_add::take_wish`]).
///
/// **Several cards are recorded as the feed's `clear` row**, the one sentence `activityText.ts`
/// has for a run of cards leaving the wishlist at once. One card is an ordinary `remove`.
fn unwish_received(conn: &Connection, lines: &[Closing]) -> Result<i64, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT w.id, wf.name
               FROM wishlist_entries w
               LEFT JOIN wishlist_folders wf ON wf.id = w.folder_id
              WHERE {wished}
              ORDER BY (w.card_id IS NULL OR w.card_id <> ?1),
                       (w.preferred_finish IS NOT NULL AND w.preferred_finish <> ?2),
                       (w.folder_id IS NOT NULL), wf.sort_order, w.id",
            wished = wish_for("?1")
        ))
        .map_err(|e| e.to_string())?;
    let mut moved = Vec::new();
    for line in lines.iter().filter(|line| line.side == THEIRS) {
        let wishes: Vec<(i64, Option<String>)> = stmt
            .query_map(params![line.card_id, line.finish], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        let mut left = line.quantity;
        let mut places = Vec::new();
        for (wish, folder) in wishes {
            if left == 0 {
                break;
            }
            left -= crate::deck_quick_add::take_wish(conn, wish, &line.card_id, left)?;
            places.push(folder);
        }
        if left < line.quantity {
            moved.push(Moved {
                line,
                copies: line.quantity - left,
                folder: only_place(&places),
            });
        }
    }
    let copies = copies_of(&moved);
    let folder = moved.first().and_then(|m| m.folder.clone());
    record_step(
        conn,
        crate::activity::WISHLIST,
        &moved,
        (crate::activity::REMOVE, json!({ "folder": folder })),
        (
            crate::activity::CLEAR,
            json!({ "cards": copies, "trade": true }),
        ),
        -1,
    )?;
    Ok(copies)
}

/// Step 4 — put the cards the reader gave on the wishlist, each pinned to the printing and
/// finish that left. Answers the copies wished for.
///
/// The wishlist's own bulk pair: [`crate::wishlist::add_wish_silent`] per line and one
/// [`crate::wishlist::record_wishes_added`] for the run, at the root. A wish the list already
/// holds at that grain is raised, as any add raises it.
///
/// A line whose printing has left the card database is skipped, [`add_received`]'s reason: a
/// wish pinned to a printing has to be able to name it.
fn wish_given(conn: &Connection, lines: &[Closing]) -> Result<i64, String> {
    let mut wishes = 0;
    let mut copies: i64 = 0;
    for line in lines.iter().filter(|line| line.side == MINE && line.known) {
        crate::wishlist::add_wish_silent(
            conn,
            &crate::wishlist::WishInput {
                card_id: Some(line.card_id.clone()),
                quantity: line.quantity,
                preferred_finish: Some(line.finish.clone()),
                ..Default::default()
            },
        )?;
        wishes += 1;
        copies = copies.saturating_add(line.quantity);
    }
    if wishes > 0 {
        crate::wishlist::record_wishes_added(conn, wishes, copies, None)?;
    }
    Ok(copies)
}

/// Finish an open trade: run the steps the reader chose, freeze the prices and file the trade
/// as finished. Answers what **this** finish did, in copies.
///
/// # The order of the four steps
///
/// Given cards leave the collection before received ones arrive, and received cards come off
/// the wishlist before given ones go on it — so a card on both sides of a trade (a swap of one
/// printing for another finish of it) is settled the way it would be by hand, and no step can
/// take back what a later one put down.
///
/// # One savepoint
///
/// The four steps and the close land together or not at all. It is a savepoint and not a
/// transaction ([`crate::db::in_savepoint`]) so that the collection's and the wishlist's own
/// savepoint-built functions nest inside it; nothing called from here opens a transaction of its
/// own.
///
/// # What is kept on the trade
///
/// `finished_before` is set and never cleared, which is what lets the dialog open with every
/// box off on a second pass. **`outcome` is every finish's work added together**, not the last
/// one's: a trade finished, reopened to fix a line and finished again with the boxes off has
/// still had cards taken out of the collection, and the archive's sentence about it must not
/// turn into *nothing changed*. The command's answer is this press alone.
///
/// An empty trade can be finished — there is nothing to refuse about it — and a trade finished
/// with every step off is closed and nothing else is touched.
///
/// **The caller owes the facet index its `owned` refresh** (`collection_source::
/// with_write_owned`): steps 1 and 2 change what the reader owns.
pub fn finish_trade(
    conn: &Connection,
    id: i64,
    options: &TradeFinishOptions,
) -> Result<TradeOutcome, String> {
    crate::db::in_savepoint(conn, "trade_finish", || {
        let trade = open_trade(conn, id)?;
        let lines = closing_lines(conn, id)?;
        let mut done = TradeOutcome::default();
        if options.remove_given {
            let given = take_given(conn, &lines)?;
            done.removed_from_collection = given.copies;
            done.removed_from_decks = given.from_decks;
        }
        if options.add_received {
            done.added_to_collection = add_received(conn, &lines, options.folder_id)?;
        }
        if options.unwish_received {
            done.removed_from_wishlist = unwish_received(conn, &lines)?;
        }
        if options.wish_given {
            done.added_to_wishlist = wish_given(conn, &lines)?;
        }

        freeze_prices(conn, id, trade.market())?;
        let kept = trade.outcome.map_or(done, |before| before.plus(done));
        conn.execute(
            "UPDATE trades
                SET status = ?2, finished_before = 1, closed_at = unixepoch(), outcome = ?3
              WHERE id = ?1",
            params![
                id,
                FINISHED,
                serde_json::to_string(&kept).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(done)
    })
}

/// Put an open trade away without finishing it: freeze the prices and file it as archived. The
/// collection and the wishlist are not touched, and neither is `outcome` — a trade that was
/// finished once, reopened and then archived still says what that finish did.
pub fn archive_trade(conn: &Connection, id: i64) -> Result<(), String> {
    crate::db::in_savepoint(conn, "trade_archive", || {
        let trade = open_trade(conn, id)?;
        freeze_prices(conn, id, trade.market())?;
        conn.execute(
            "UPDATE trades SET status = ?2, closed_at = unixepoch() WHERE id = ?1",
            params![id, ARCHIVED],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Take a finished or archived trade back to open, on live prices.
///
/// **Nothing a finish did is undone** — the cards stay where the finish put them, and
/// `finished_before` and `outcome` stay as the record of it. What goes is the frozen price on
/// every line and the closing time.
///
/// A trade that is already open is a success with nothing to do: the press that reaches here
/// twice has what it asked for.
pub fn reopen_trade(conn: &Connection, id: i64) -> Result<(), String> {
    crate::db::in_savepoint(conn, "trade_reopen", || {
        let trade = header(conn, id)?.ok_or_else(|| GONE.to_owned())?;
        if trade.open() {
            return Ok(());
        }
        conn.execute(
            "UPDATE trade_lines SET unit_price = NULL WHERE trade_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE trades SET status = ?2, closed_at = NULL WHERE id = ?1",
            params![id, OPEN],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Copy a trade — any trade, open or not — into a new open one, and answer the copy's id.
///
/// The same lines, in the same order, with the same marketplace and percentages, named
/// `{name} copy`. **None of what makes the original a closed trade comes across**: no frozen
/// prices, no closing time, no outcome and `finished_before` at 0 — the copy has never been
/// finished, so its dialog opens with the first-pass defaults.
///
/// Each line is copied whole into an empty trade, so nothing folds and no quantity is summed:
/// a copy cannot hold a line above [`MAX_QUANTITY`] that its original does not.
pub fn duplicate_trade(conn: &Connection, id: i64) -> Result<i64, String> {
    crate::db::in_savepoint(conn, "trade_duplicate", || {
        let copy: i64 = conn
            .query_row(
                "INSERT INTO trades (name, marketplace, rate_mine, rate_theirs, created_at)
                 SELECT name || ' copy', marketplace, rate_mine, rate_theirs, unixepoch()
                   FROM trades WHERE id = ?1
                 RETURNING id",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| GONE.to_owned())?;
        conn.execute(
            "INSERT INTO trade_lines
                (trade_id, side, card_id, name, set_code, collector_number, finish, quantity,
                 source, position)
             SELECT ?2, side, card_id, name, set_code, collector_number, finish, quantity,
                    source, position
               FROM trade_lines WHERE trade_id = ?1
              ORDER BY position, id",
            params![id, copy],
        )
        .map_err(|e| e.to_string())?;
        Ok(copy)
    })
}

/// Delete a trade and its lines, whatever its status. A trade that is already gone is a
/// success, [`remove_trade_line`]'s rule.
///
/// **The lines are deleted by name and not left to `ON DELETE CASCADE`**: `foreign_keys` is a
/// per-connection pragma, and on a connection that never set it the cascade is a comment.
pub fn delete_trade(conn: &Connection, id: i64) -> Result<(), String> {
    crate::db::in_savepoint(conn, "trade_delete", || {
        conn.execute("DELETE FROM trade_lines WHERE trade_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM trades WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection::{add_entry, add_entry_filed, EntryInput, DECK_WRITE_FOLDERS};
    use crate::schema::fixtures::{deck as seed_deck, seed_card};
    use crate::wishlist::{add_wish, WishInput};
    use serde_json::Value;

    /// **`foreign_keys` is ON**, as [`crate::db::open`] sets it for every connection the app
    /// hands out — `collection_entries.folder_id` SET NULLs and `trade_lines.trade_id` CASCADEs,
    /// and both are per-connection settings.
    fn open() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// One printing: its oracle card, its name, the finishes it is sold in and Scryfall's price
    /// blob. `cards` is seeded here because a test database has never synced, and the rows go
    /// with the connection.
    fn card(conn: &Connection, id: &str, oracle: &str, name: &str, finishes: &str, prices: &str) {
        seed_card(conn, id, "tst", id);
        conn.execute(
            "UPDATE cards SET oracle_id = ?2, name = ?3, finishes = ?4, prices = ?5,
                              rarity = 'rare', set_name = 'Test Set'
              WHERE id = ?1",
            params![id, oracle, name, finishes, prices],
        )
        .unwrap();
    }

    /// Four printings of three cards: Bolt twice (one sold nonfoil and foil, one nonfoil only),
    /// a Tarmogoyf in all three finishes, and a charm that exists only in foil.
    fn seeded() -> Connection {
        let conn = open();
        card(
            &conn,
            "bolt",
            "o-bolt",
            "Lightning Bolt",
            r#"["nonfoil","foil"]"#,
            r#"{"usd":"2.00","usd_foil":"9.00","eur":"1.50","eur_foil":"7.00"}"#,
        );
        card(
            &conn,
            "bolt-2",
            "o-bolt",
            "Lightning Bolt",
            r#"["nonfoil"]"#,
            r#"{"usd":"1.00"}"#,
        );
        card(
            &conn,
            "goyf",
            "o-goyf",
            "Tarmogoyf",
            r#"["nonfoil","foil","etched"]"#,
            r#"{"usd":"20.00","usd_foil":"45.00","usd_etched":"30.00"}"#,
        );
        card(
            &conn,
            "charm",
            "o-charm",
            "Boros Charm",
            r#"["foil"]"#,
            r#"{"usd_foil":"3.00"}"#,
        );
        conn
    }

    fn new_trade(conn: &Connection) -> i64 {
        create_trade(conn, &TradeCreate::default()).unwrap()
    }

    fn input(card_id: &str, finish: &str, quantity: i64, source: &str) -> TradeLineInput {
        TradeLineInput {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            quantity,
            source: source.to_owned(),
        }
    }

    /// Put one card on a side and answer nothing: the line is read back by the test that cares.
    fn put(conn: &Connection, trade: i64, side: &str, card_id: &str, finish: &str, quantity: i64) {
        add_trade_lines(
            conn,
            trade,
            side,
            &[input(card_id, finish, quantity, "search")],
        )
        .unwrap();
    }

    fn trade(conn: &Connection, id: i64) -> Trade {
        get_trade(conn, id).unwrap().expect("the trade is there")
    }

    /// A side's lines as `(card, finish, quantity)`, in the order the page reads them.
    fn side(conn: &Connection, id: i64, side: &str) -> Vec<(String, String, i64)> {
        trade(conn, id)
            .lines
            .into_iter()
            .filter(|line| line.side == side)
            .map(|line| (line.card_id, line.finish, line.quantity))
            .collect()
    }

    fn line_id(conn: &Connection, id: i64, side: &str, card_id: &str, finish: &str) -> i64 {
        trade(conn, id)
            .lines
            .into_iter()
            .find(|l| l.side == side && l.card_id == card_id && l.finish == finish)
            .expect("the line is on the trade")
            .id
    }

    fn own(conn: &Connection, card_id: &str, finish: &str, quantity: i64, folder: Option<i64>) {
        add_entry(
            conn,
            &EntryInput {
                card_id: card_id.to_owned(),
                finish: finish.to_owned(),
                quantity,
                folder_id: folder,
                ..Default::default()
            },
        )
        .unwrap();
    }

    fn binder(conn: &Connection, name: &str) -> i64 {
        crate::collection_folders::create_folder(conn, None, name)
            .unwrap()
            .id
    }

    /// Copies of a printing and finish in one place — `None` is the root.
    fn held(conn: &Connection, card_id: &str, finish: &str, folder: Option<i64>) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE card_id = ?1 AND finish = ?2 AND folder_id IS ?3",
            params![card_id, finish, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Every wish as `(card_id, preferred_finish, quantity)`, oldest first.
    fn wishes(conn: &Connection) -> Vec<(Option<String>, Option<String>, i64)> {
        conn.prepare("SELECT card_id, preferred_finish, quantity FROM wishlist_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// The feed, newest first, as `(scope, kind, card name, payload, delta)`.
    fn feed(conn: &Connection) -> Vec<(String, String, Option<String>, Value, i64)> {
        crate::activity::recent(conn, 50)
            .unwrap()
            .into_iter()
            .map(|row| {
                let payload = serde_json::from_str(&row.payload).unwrap();
                (row.scope, row.kind, row.card_name, payload, row.delta)
            })
            .collect()
    }

    const ALL: TradeFinishOptions = TradeFinishOptions {
        remove_given: true,
        add_received: true,
        folder_id: None,
        unwish_received: true,
        wish_given: true,
    };

    const NONE: TradeFinishOptions = TradeFinishOptions {
        remove_given: false,
        add_received: false,
        folder_id: None,
        unwish_received: false,
        wish_given: false,
    };

    /// A trade made with nothing said is named after its own id, priced where the reader
    /// currently is, and born open at 100% on both sides.
    #[test]
    fn a_new_trade_takes_its_name_from_its_id_and_its_marketplace_from_the_reader() {
        let conn = seeded();
        crate::marketplace::store(&conn, "cardmarket").unwrap();

        let first = new_trade(&conn);
        let made = trade(&conn, first);
        assert_eq!(made.name, format!("Trade {first}"));
        assert_eq!(made.marketplace, "cardmarket");
        assert_eq!((made.rate_mine, made.rate_theirs), (100, 100));
        assert_eq!(made.status, OPEN);
        assert!(!made.finished_before);
        assert_eq!(made.outcome, None);
        assert_eq!(made.closed_at, None);
        assert!(made.lines.is_empty());

        // A name and a marketplace that are given are taken, the name trimmed; a blank name is
        // no name.
        let named = create_trade(
            &conn,
            &TradeCreate {
                name: Some("  Store night  ".to_owned()),
                marketplace: Some("manapool".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(trade(&conn, named).name, "Store night");
        assert_eq!(trade(&conn, named).marketplace, "manapool");
        let blank = create_trade(
            &conn,
            &TradeCreate {
                name: Some("   ".to_owned()),
                marketplace: None,
            },
        )
        .unwrap();
        assert_eq!(trade(&conn, blank).name, format!("Trade {blank}"));
    }

    /// A trade is always in a marketplace that quotes prices: Card trader has no feed and reads
    /// as TCGplayer everywhere, so that is what is stored, asked for or inherited. An id nobody
    /// knows is refused rather than quietly priced in dollars.
    #[test]
    fn a_trade_is_only_ever_in_a_marketplace_that_quotes_prices() {
        let conn = seeded();
        let asked = create_trade(
            &conn,
            &TradeCreate {
                name: None,
                marketplace: Some("cardtrader".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(trade(&conn, asked).marketplace, "tcgplayer");

        crate::marketplace::store(&conn, "cardtrader").unwrap();
        let inherited = new_trade(&conn);
        assert_eq!(trade(&conn, inherited).marketplace, "tcgplayer");

        let err = create_trade(
            &conn,
            &TradeCreate {
                name: None,
                marketplace: Some("ebay".to_owned()),
            },
        )
        .unwrap_err();
        assert!(err.contains("ebay"), "{err}");
        assert_eq!(list_trades(&conn).unwrap().len(), 2, "and made no trade");
    }

    /// The grain: one line per printing and finish on a side. A second add raises the first
    /// line and keeps its source; another finish, or the other side, is a line of its own.
    #[test]
    fn adding_a_printing_a_side_already_holds_raises_that_line() {
        let conn = seeded();
        let id = new_trade(&conn);
        add_trade_lines(
            &conn,
            id,
            MINE,
            &[input("bolt", "nonfoil", 1, "collection")],
        )
        .unwrap();
        add_trade_lines(
            &conn,
            id,
            MINE,
            &[
                input("bolt", "nonfoil", 2, "scan"),
                input("bolt", "foil", 1, "search"),
                // Twice in one call folds too: the second finds the first.
                input("goyf", "etched", 1, "scan"),
                input("goyf", "etched", 1, "scan"),
            ],
        )
        .unwrap();
        put(&conn, id, THEIRS, "bolt", "nonfoil", 4);

        assert_eq!(
            side(&conn, id, MINE),
            [
                ("bolt".to_owned(), "nonfoil".to_owned(), 3),
                ("bolt".to_owned(), "foil".to_owned(), 1),
                ("goyf".to_owned(), "etched".to_owned(), 2),
            ],
            "in the order they were first added"
        );
        assert_eq!(
            side(&conn, id, THEIRS),
            [("bolt".to_owned(), "nonfoil".to_owned(), 4)]
        );
        let after = trade(&conn, id);
        let raised = &after.lines[0];
        assert_eq!(
            raised.source, "collection",
            "the line keeps where it came from"
        );
        assert_eq!(raised.name, "Lightning Bolt");
        assert_eq!(
            (raised.set_code.as_str(), raised.collector_number.as_str()),
            ("tst", "bolt")
        );
    }

    /// A bad line refuses the whole call and leaves the side as it was — and each refusal says
    /// what was wrong with the line rather than failing a constraint.
    #[test]
    fn a_refused_line_adds_nothing_from_its_batch() {
        let conn = seeded();
        let id = new_trade(&conn);
        let good = || input("bolt", "nonfoil", 1, "search");
        let refused = |side: &str, bad: TradeLineInput| {
            add_trade_lines(&conn, id, side, &[good(), bad]).unwrap_err()
        };

        assert_eq!(
            refused(MINE, input("bolt", "nonfoil", 0, "search")),
            NO_COPIES
        );
        assert_eq!(
            refused(MINE, input("nobody", "nonfoil", 1, "search")),
            NO_SUCH_CARD
        );
        assert!(refused(MINE, input("bolt", "gilded", 1, "search")).contains("gilded"));
        assert!(refused(MINE, input("bolt", "nonfoil", 1, "import")).contains("import"));
        assert!(refused("ours", good()).contains("ours"));
        assert!(
            trade(&conn, id).lines.is_empty(),
            "the good line went back with the bad"
        );

        assert_eq!(
            add_trade_lines(&conn, 999, MINE, &[good()]).unwrap_err(),
            GONE
        );
    }

    /// A line holds at most [`MAX_QUANTITY`] copies however it would come to hold more: asked
    /// outright, raised by an add, or folded by an edit. Each is refused in a sentence — never
    /// stored as the REAL SQLite makes of an overflowing sum, which would leave every trade
    /// unreadable — and a refused add still takes its whole batch back.
    #[test]
    fn a_line_never_holds_more_than_the_ceiling_however_it_is_asked() {
        let conn = seeded();
        let id = new_trade(&conn);
        assert!(
            TOO_MANY.contains(&MAX_QUANTITY.to_string()),
            "the sentence names the ceiling"
        );
        let good = || input("goyf", "foil", 1, "search");
        let refused = |side: &str, bad: TradeLineInput| {
            add_trade_lines(&conn, id, side, &[good(), bad]).unwrap_err()
        };

        // The ceiling itself is a quantity; one past it is not, and neither is the far end of
        // an `i64`.
        put(&conn, id, MINE, "bolt", "nonfoil", MAX_QUANTITY);
        for quantity in [MAX_QUANTITY + 1, i64::MAX] {
            assert_eq!(
                refused(THEIRS, input("bolt", "foil", quantity, "search")),
                TOO_MANY
            );
        }
        // By a fold: one more onto a full line, and two inputs that only pass it together.
        assert_eq!(refused(MINE, input("bolt", "nonfoil", 1, "scan")), TOO_MANY);
        assert_eq!(
            add_trade_lines(
                &conn,
                id,
                THEIRS,
                &[
                    input("charm", "foil", 6000, "search"),
                    input("charm", "foil", 4000, "search"),
                ],
            )
            .unwrap_err(),
            TOO_MANY
        );
        assert_eq!(
            side(&conn, id, MINE),
            [("bolt".to_owned(), "nonfoil".to_owned(), MAX_QUANTITY)]
        );
        assert!(
            side(&conn, id, THEIRS).is_empty(),
            "every good line went back with the bad one"
        );

        // An edit is held to it three ways: the quantity it names, a fold it causes without
        // naming one, and a move across that lands on a line with no room.
        put(&conn, id, MINE, "bolt", "foil", 6000);
        put(&conn, id, THEIRS, "bolt", "nonfoil", 1);
        let foil = line_id(&conn, id, MINE, "bolt", "foil");
        let theirs = line_id(&conn, id, THEIRS, "bolt", "nonfoil");
        for quantity in [MAX_QUANTITY + 1, i64::MAX] {
            let change = TradeLineChange {
                quantity: Some(quantity),
                ..Default::default()
            };
            assert_eq!(
                update_trade_line(&conn, foil, &change).unwrap_err(),
                TOO_MANY
            );
        }
        let onto_the_full_line = TradeLineChange {
            finish: Some("nonfoil".to_owned()),
            ..Default::default()
        };
        assert_eq!(
            update_trade_line(&conn, foil, &onto_the_full_line).unwrap_err(),
            TOO_MANY
        );
        let across = TradeLineChange {
            side: Some(MINE.to_owned()),
            ..Default::default()
        };
        assert_eq!(
            update_trade_line(&conn, theirs, &across).unwrap_err(),
            TOO_MANY
        );
        assert_eq!(
            side(&conn, id, MINE),
            [
                ("bolt".to_owned(), "nonfoil".to_owned(), MAX_QUANTITY),
                ("bolt".to_owned(), "foil".to_owned(), 6000),
            ],
            "a refused fold deletes neither line"
        );
        assert_eq!(
            side(&conn, id, THEIRS),
            [("bolt".to_owned(), "nonfoil".to_owned(), 1)]
        );

        // A fold that lands exactly on the ceiling is a fold.
        put(&conn, id, THEIRS, "bolt", "foil", MAX_QUANTITY - 6000);
        let rest = line_id(&conn, id, THEIRS, "bolt", "foil");
        update_trade_line(&conn, rest, &across).unwrap();
        assert_eq!(
            side(&conn, id, MINE)[1],
            ("bolt".to_owned(), "foil".to_owned(), MAX_QUANTITY)
        );

        // A figure read back out of the column is not trusted either: a row some other hand
        // wrote at the top of an `i64` refuses the add rather than overflowing under it.
        conn.execute(
            "UPDATE trade_lines SET quantity = ?2 WHERE id = ?1",
            params![theirs, i64::MAX],
        )
        .unwrap();
        assert_eq!(
            refused(THEIRS, input("bolt", "nonfoil", 1, "search")),
            TOO_MANY
        );
        let reals: i64 = conn
            .query_row(
                "SELECT count(*) FROM trade_lines WHERE typeof(quantity) <> 'integer'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(reals, 0, "and every quantity stored is still an integer");
        assert!(get_trade(&conn, id).unwrap().is_some());

        // A stored outcome is JSON out of a column, and adding to one saturates.
        let most = TradeOutcome {
            removed_from_collection: i64::MAX,
            ..Default::default()
        };
        assert_eq!(most.plus(most).removed_from_collection, i64::MAX);
    }

    /// An edit changes what it names and nothing else, and its three refusals are sentences.
    #[test]
    fn an_edit_changes_what_it_names_and_refuses_in_words() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 2);
        let line = line_id(&conn, id, MINE, "bolt", "nonfoil");
        let change = |change: TradeLineChange| update_trade_line(&conn, line, &change);

        change(TradeLineChange {
            quantity: Some(5),
            ..Default::default()
        })
        .unwrap();
        change(TradeLineChange {
            finish: Some("foil".to_owned()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            side(&conn, id, MINE),
            [("bolt".to_owned(), "foil".to_owned(), 5)]
        );

        // Zero is not a removal, etched is not a finish this Bolt comes in, and a printing has
        // to exist to be picked.
        for quantity in [0, -1] {
            let err = change(TradeLineChange {
                quantity: Some(quantity),
                ..Default::default()
            })
            .unwrap_err();
            assert_eq!(err, NO_COPIES);
        }
        let err = change(TradeLineChange {
            finish: Some("etched".to_owned()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(err, FINISH_NOT_SOLD);
        let err = change(TradeLineChange {
            card_id: Some("nobody".to_owned()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(err, NO_SUCH_CARD);
        // A refusal after an accepted field writes neither: the quantity here would have
        // landed before the finish was looked at.
        let err = change(TradeLineChange {
            quantity: Some(9),
            finish: Some("etched".to_owned()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(err, FINISH_NOT_SOLD);
        assert_eq!(
            side(&conn, id, MINE),
            [("bolt".to_owned(), "foil".to_owned(), 5)],
            "nothing a refused edit named was written"
        );

        assert_eq!(
            update_trade_line(&conn, 999, &TradeLineChange::default()).unwrap_err(),
            LINE_GONE
        );
    }

    /// Picking another printing carries the finish across when the new printing is sold in it,
    /// and otherwise lands on the new printing's first finish — and the line's own copy of the
    /// name, set and number follows the printing.
    #[test]
    fn a_new_printing_keeps_the_finish_it_can_and_takes_its_first_otherwise() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "foil", 1);
        put(&conn, id, THEIRS, "bolt", "nonfoil", 1);
        let repoint = |line: i64, card: &str, finish: Option<&str>| {
            update_trade_line(
                &conn,
                line,
                &TradeLineChange {
                    card_id: Some(card.to_owned()),
                    finish: finish.map(str::to_owned),
                    ..Default::default()
                },
            )
        };

        // Foil Bolt → a printing that only exists nonfoil.
        repoint(line_id(&conn, id, MINE, "bolt", "foil"), "bolt-2", None).unwrap();
        assert_eq!(
            side(&conn, id, MINE),
            [("bolt-2".to_owned(), "nonfoil".to_owned(), 1)]
        );
        // Nonfoil Bolt → Tarmogoyf, which is sold nonfoil: the finish stays.
        repoint(line_id(&conn, id, THEIRS, "bolt", "nonfoil"), "goyf", None).unwrap();
        let after = trade(&conn, id);
        let moved = &after.lines[1];
        assert_eq!(
            (moved.card_id.as_str(), moved.finish.as_str()),
            ("goyf", "nonfoil")
        );
        assert_eq!(moved.name, "Tarmogoyf");
        assert_eq!(moved.collector_number, "goyf");

        // A printing and a finish named together: the finish is checked against the NEW
        // printing, so etched is fine for the Goyf and refused for the charm.
        let goyf = line_id(&conn, id, THEIRS, "goyf", "nonfoil");
        assert_eq!(
            repoint(goyf, "charm", Some("etched")).unwrap_err(),
            FINISH_NOT_SOLD
        );
        repoint(
            line_id(&conn, id, MINE, "bolt-2", "nonfoil"),
            "goyf",
            Some("etched"),
        )
        .unwrap();
        assert_eq!(
            side(&conn, id, MINE),
            [("goyf".to_owned(), "etched".to_owned(), 1)]
        );
    }

    /// An edit that makes a line the same as another on its side folds the two: the edited line
    /// keeps its place and takes the other's copies. A move across sides folds the same way, and
    /// a move that folds into nothing goes to the end.
    #[test]
    fn an_edit_onto_another_line_folds_the_two_into_the_edited_one() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 2);
        put(&conn, id, MINE, "goyf", "nonfoil", 1);
        put(&conn, id, MINE, "bolt", "foil", 3);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 4);
        let first = line_id(&conn, id, MINE, "bolt", "nonfoil");

        // The first line becomes foil, which the third already is.
        update_trade_line(
            &conn,
            first,
            &TradeLineChange {
                finish: Some("foil".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            side(&conn, id, MINE),
            [
                ("bolt".to_owned(), "foil".to_owned(), 5),
                ("goyf".to_owned(), "nonfoil".to_owned(), 1),
            ],
            "one line, where the edited one was"
        );
        assert_eq!(line_id(&conn, id, MINE, "bolt", "foil"), first);

        // Their Goyf moves to my side, onto my Goyf — and a quantity named in the same edit is
        // the moved line's, with the other's added.
        let theirs = line_id(&conn, id, THEIRS, "goyf", "nonfoil");
        update_trade_line(
            &conn,
            theirs,
            &TradeLineChange {
                side: Some(MINE.to_owned()),
                quantity: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(side(&conn, id, THEIRS).is_empty());
        assert_eq!(
            side(&conn, id, MINE),
            [
                ("bolt".to_owned(), "foil".to_owned(), 5),
                ("goyf".to_owned(), "nonfoil".to_owned(), 3),
            ]
        );
        assert_eq!(line_id(&conn, id, MINE, "goyf", "nonfoil"), theirs);
    }

    /// 50 to 150 in steps of 5, per side, and nothing is rounded into range.
    #[test]
    fn a_rate_is_fifty_to_one_fifty_in_fives_on_one_side() {
        let conn = seeded();
        let id = new_trade(&conn);
        for rate in [50, 85, 150] {
            set_trade_rate(&conn, id, THEIRS, rate).unwrap();
            assert_eq!(trade(&conn, id).rate_theirs, rate);
        }
        set_trade_rate(&conn, id, MINE, 120).unwrap();
        assert_eq!(
            (trade(&conn, id).rate_mine, trade(&conn, id).rate_theirs),
            (120, 150)
        );
        for rate in [45, 155, 52, 0, -100] {
            assert!(
                set_trade_rate(&conn, id, MINE, rate).is_err(),
                "{rate} is off the grid"
            );
        }
        assert!(set_trade_rate(&conn, id, "ours", 100).is_err());
        assert_eq!(trade(&conn, id).rate_mine, 120, "a refusal stores nothing");
    }

    /// The unit price is live while the trade is open, at the finish the line names and in the
    /// trade's own marketplace — not the one the reader has switched to since.
    #[test]
    fn an_open_trade_is_priced_live_in_its_own_marketplace() {
        let conn = seeded();
        let dollars = new_trade(&conn);
        let euros = create_trade(
            &conn,
            &TradeCreate {
                name: None,
                marketplace: Some("cardmarket".to_owned()),
            },
        )
        .unwrap();
        for id in [dollars, euros] {
            put(&conn, id, MINE, "bolt", "foil", 2);
            put(&conn, id, THEIRS, "goyf", "etched", 1);
        }
        // The reader's own setting moves; neither trade follows it.
        crate::marketplace::store(&conn, "manapool").unwrap();

        let unit = |id: i64| -> Vec<Option<f64>> {
            trade(&conn, id)
                .lines
                .iter()
                .map(|l| l.unit_price)
                .collect()
        };
        assert_eq!(unit(dollars), [Some(9.0), Some(30.0)]);
        assert_eq!(
            unit(euros),
            [Some(7.0), None],
            "Cardmarket quotes no etched price, and that is an em dash, not a nonfoil figure"
        );
        let priced = trade(&conn, dollars);
        let bolt = &priced.lines[0];
        assert_eq!(
            (
                bolt.finish_prices.nonfoil,
                bolt.finish_prices.foil,
                bolt.finish_prices.etched
            ),
            (Some(2.0), Some(9.0), None)
        );
        assert_eq!(bolt.finishes.as_deref(), Some(r#"["nonfoil","foil"]"#));
        assert_eq!(bolt.oracle_id.as_deref(), Some("o-bolt"));
        assert_eq!(bolt.set_name.as_deref(), Some("Test Set"));

        conn.execute(
            r#"UPDATE cards SET prices = '{"usd":"2.00","usd_foil":"11.50"}' WHERE id = 'bolt'"#,
            [],
        )
        .unwrap();
        assert_eq!(unit(dollars)[0], Some(11.5), "tomorrow's price, tomorrow");

        // And the list states the same figures, newest trade first.
        let list = list_trades(&conn).unwrap();
        assert_eq!(
            list.iter().map(|t| t.id).collect::<Vec<_>>(),
            [euros, dollars]
        );
        let summary = &list[1];
        assert_eq!(summary.marketplace, "tcgplayer");
        assert_eq!(
            summary
                .lines
                .iter()
                .map(|l| (l.side.as_str(), l.quantity, l.unit_price))
                .collect::<Vec<_>>(),
            [("mine", 2, Some(11.5)), ("theirs", 1, Some(30.0))]
        );
    }

    /// What a line says about the collection, in its own printing and finish. `owned` is the
    /// root and the reader's unlocked folders; `owned_in_decks` is every deck's group, counted
    /// apart, with the decks named in the order a finish would take from them. A locked binder
    /// or a folder inside one, `Recently removed`, a proxy and another finish are in neither.
    #[test]
    fn a_line_counts_its_copies_outside_decks_and_in_them_apart() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 1);
        let held = || {
            let line = trade(&conn, id).lines.remove(0);
            (line.owned, line.owned_in_decks, line.deck_names)
        };
        let nowhere: Vec<String> = Vec::new();
        assert_eq!(held(), (0, 0, nowhere.clone()));

        own(&conn, "bolt", "nonfoil", 2, None);
        own(&conn, "bolt", "nonfoil", 3, Some(binder(&conn, "Binder")));
        own(&conn, "bolt", "foil", 7, None);
        assert_eq!(held(), (5, 0, nowhere));

        // A locked binder, and a folder inside it that carries no flag of its own.
        let locked = binder(&conn, "Graded");
        let inside = crate::collection_folders::create_folder(&conn, Some(locked), "Slabs")
            .unwrap()
            .id;
        own(&conn, "bolt", "nonfoil", 10, Some(locked));
        own(&conn, "bolt", "nonfoil", 20, Some(inside));
        crate::collection_folders::set_folder_locked(&conn, locked, true).unwrap();
        // The holding area — written straight in, since no add may name it — and a proxy.
        let removed: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                 (card_id, set_code, collector_number, lang, finish, condition, quantity,
                  folder_id, created_at, updated_at)
             VALUES ('bolt', 'tst', 'bolt', 'en', 'nonfoil', 'NM', 40, ?1,
                     unixepoch(), unixepoch())",
            params![removed],
        )
        .unwrap();
        add_entry(
            &conn,
            &EntryInput {
                card_id: "bolt".to_owned(),
                finish: "nonfoil".to_owned(),
                quantity: 80,
                proxy: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            held().0,
            5,
            "none of the four is the reader's to trade away"
        );

        // Two decks. Burn's signed copy is the oldest row of the three, and Storm is still
        // named first: plain copies go before special ones, and a deck is named once.
        let (_, burn) = deck_and_group(&conn, "Burn");
        let (_, storm) = deck_and_group(&conn, "Storm");
        sleeve(&conn, "bolt", "nonfoil", 1, burn, |e| e.signed = true);
        sleeve(&conn, "bolt", "nonfoil", 2, storm, |_| {});
        sleeve(&conn, "bolt", "nonfoil", 3, burn, |_| {});
        sleeve(&conn, "bolt", "foil", 9, storm, |_| {});
        assert_eq!(
            held(),
            (5, 6, vec!["Storm".to_owned(), "Burn".to_owned()]),
            "a deck's copies are counted, and never as `owned`"
        );
    }

    /// A deck and the collection folder that stands for it, wearing its name as
    /// `deck::create_deck` and a rename both leave it. Answers the deck and the folder.
    fn deck_and_group(conn: &Connection, name: &str) -> (i64, i64) {
        let deck = seed_deck(conn, name);
        let group = conn
            .query_row(
                "INSERT INTO collection_folders
                     (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
                 VALUES (NULL, ?2, 'deck', ?1, 0, unixepoch(), unixepoch()) RETURNING id",
                params![deck, name],
                |r| r.get(0),
            )
            .unwrap();
        (deck, group)
    }

    /// The group of a deck called `Burn`, for a test that only needs one to exist.
    fn deck_group(conn: &Connection) -> i64 {
        deck_and_group(conn, "Burn").1
    }

    /// Copies filed in a deck's group, through the door a deck's own writes file by. `change`
    /// is what makes a row unlike its neighbour — two rows of one printing in one folder must
    /// differ in a grain term to exist at all.
    fn sleeve(
        conn: &Connection,
        card_id: &str,
        finish: &str,
        quantity: i64,
        group: i64,
        change: fn(&mut EntryInput),
    ) {
        let mut entry = EntryInput {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            quantity,
            folder_id: Some(group),
            ..Default::default()
        };
        change(&mut entry);
        add_entry_filed(conn, &entry, DECK_WRITE_FOLDERS).unwrap();
    }

    /// A managed wishlist's folder, and one wish in it for `card_id`.
    fn managed_wish(conn: &Connection, card_id: &str, oracle: &str, quantity: i64) {
        let folder: i64 = conn
            .query_row(
                "INSERT INTO wishlist_folders
                     (parent_id, name, sort_order, created_at, updated_at, managed_deck_id)
                 VALUES (NULL, 'Burn wants', 0, 0, 0, 7) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries
                 (oracle_id, card_id, name, quantity, folder_id, created_at, updated_at)
             VALUES (?2, ?1, 'Lightning Bolt', ?3, ?4, 0, 0)",
            params![card_id, oracle, quantity, folder],
        )
        .unwrap();
    }

    /// `wished` is the card, not the printing: a wish for any printing of it counts, in any
    /// finish — and a managed wishlist's wish does not, because that one is its deck's.
    #[test]
    fn wished_counts_the_card_in_any_printing_outside_managed_wishlists() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, THEIRS, "bolt", "nonfoil", 1);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 1);
        let wished = || -> Vec<i64> { trade(&conn, id).lines.iter().map(|l| l.wished).collect() };
        assert_eq!(wished(), [0, 0]);

        // The other printing, pinned and foil-preferring; and the card with no printing named.
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-2".to_owned()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-bolt".to_owned()),
                quantity: 1,
                preferred_finish: Some("foil".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        managed_wish(&conn, "bolt", "o-bolt", 9);
        assert_eq!(wished(), [3, 0]);
    }

    /// A line outlives its printing: when a sync drops the row from `cards` the line still
    /// lists, under the name, set and number it was written with, and with no price.
    #[test]
    fn a_line_whose_printing_has_left_the_database_still_lists() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "foil", 2);
        own(&conn, "bolt", "foil", 1, None);
        conn.execute("DELETE FROM cards WHERE id = 'bolt'", [])
            .unwrap();

        let orphaned = trade(&conn, id);
        let line = &orphaned.lines[0];
        assert_eq!(line.name, "Lightning Bolt");
        assert_eq!(
            (line.set_code.as_str(), line.collector_number.as_str()),
            ("tst", "bolt")
        );
        assert_eq!(line.unit_price, None);
        assert_eq!(line.oracle_id, None);
        assert_eq!(line.finishes, None);
        assert_eq!(line.finish_prices.foil, None);
        assert_eq!(line.owned, 1, "the collection still holds the copy");
        assert_eq!(list_trades(&conn).unwrap()[0].lines[0].unit_price, None);

        // Its finish cannot be changed — the list of finishes went with the printing — but its
        // quantity can, and it can still be taken off.
        let err = update_trade_line(
            &conn,
            line.id,
            &TradeLineChange {
                finish: Some("nonfoil".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, FINISH_NOT_SOLD);
        update_trade_line(
            &conn,
            line.id,
            &TradeLineChange {
                quantity: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        // And a finish neither adds it to the collection nor wishes for it, but does take the
        // copy the reader gave.
        let done = finish_trade(&conn, id, &ALL).unwrap();
        assert_eq!(
            done,
            TradeOutcome {
                removed_from_collection: 1,
                ..Default::default()
            }
        );
    }

    /// Step 1. The collection gives up what it holds and no more, root first and then the
    /// reader's folders — never a locked binder's copies, and **not a deck's while the others
    /// cover the line**. Every copy here is a plain one; the next test is the order among
    /// copies that are not, and the one after the tradelist's is the line the others do not
    /// cover.
    #[test]
    fn finishing_takes_given_cards_out_of_the_root_and_then_the_readers_folders() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 4);
        put(&conn, id, MINE, "goyf", "foil", 2);
        put(&conn, id, MINE, "charm", "foil", 1);
        let first = binder(&conn, "A");
        let second = binder(&conn, "B");
        // Bolt: one at the root, two in A, five in B, three a lock holds back and four in a
        // deck. Four are asked for, so the root and A empty, B gives one and the deck none.
        own(&conn, "bolt", "nonfoil", 5, Some(second));
        own(&conn, "bolt", "nonfoil", 2, Some(first));
        own(&conn, "bolt", "nonfoil", 1, None);
        let locked = binder(&conn, "Graded");
        own(&conn, "bolt", "nonfoil", 3, Some(locked));
        crate::collection_folders::set_folder_locked(&conn, locked, true).unwrap();
        let group = deck_group(&conn);
        sleeve(&conn, "bolt", "nonfoil", 4, group, |_| {});
        // Goyf: the collection holds one foil of the two the line asks for.
        own(&conn, "goyf", "foil", 1, None);
        own(&conn, "goyf", "nonfoil", 6, None);
        // The charm is not in the collection at all.
        conn.execute("DELETE FROM activity", []).unwrap();

        let done = finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                remove_given: true,
                ..NONE
            },
        )
        .unwrap();

        assert_eq!(
            done.removed_from_collection, 5,
            "four Bolts and the one Goyf"
        );
        assert_eq!(done.removed_from_decks, 0, "and no deck gave one of them");
        assert_eq!(held(&conn, "bolt", "nonfoil", None), 0);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(first)), 0);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(second)), 4);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(locked)), 3);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(group)), 4);
        assert_eq!(held(&conn, "goyf", "foil", None), 0);
        assert_eq!(
            held(&conn, "goyf", "nonfoil", None),
            6,
            "another finish is another object"
        );
        let emptied: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE quantity = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            emptied, 0,
            "a row taken to nothing is deleted, not left at zero"
        );

        // One feed row for the step: two cards, five copies.
        assert_eq!(
            feed(&conn),
            [(
                "collection".to_owned(),
                "remove".to_owned(),
                None,
                json!({ "entries": 2, "trade": true }),
                -5
            )]
        );
        // The lines themselves are untouched: a finish records the trade, it does not edit it.
        assert_eq!(side(&conn, id, MINE).len(), 3);
    }

    /// Step 1 again, for *which* copies. A line names a printing and a finish, so the plain
    /// copies go first wherever they are filed — and a signed, graded, altered, misprinted or
    /// serial-numbered one only once they have run out. A proxy is never the card: not counted
    /// as owned, not taken.
    #[test]
    fn finishing_takes_plain_copies_before_special_ones_and_never_a_proxy() {
        let conn = seeded();
        let special = |change: fn(&mut EntryInput)| {
            let mut entry = EntryInput {
                card_id: "bolt".to_owned(),
                finish: "foil".to_owned(),
                quantity: 1,
                ..Default::default()
            };
            change(&mut entry);
            add_entry(&conn, &entry).unwrap();
        };
        // Five copies that are each one object, all at the root and all older than the plain
        // ones — everything the old walk (root first, then row id) took first.
        special(|e| {
            e.signed = true;
            e.purchase_price = Some(80.0);
            e.notes = Some("signed at the prerelease".to_owned());
        });
        special(|e| e.grading = Some(r#"{"company":"PSA","grade":"10"}"#.to_owned()));
        special(|e| e.altered = true);
        special(|e| e.misprint = true);
        special(|e| e.serial_number = Some("007/500".to_owned()));
        special(|e| {
            e.proxy = true;
            e.quantity = 5;
        });
        let folder = binder(&conn, "Binder");
        own(&conn, "bolt", "foil", 2, Some(folder));
        // What is left of the Bolts, as `(quantity, proxy)` — oldest row first.
        let left = || -> Vec<(i64, bool)> {
            conn.prepare(
                "SELECT quantity, proxy FROM collection_entries
                  WHERE card_id = 'bolt' ORDER BY id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
        };
        let give = |quantity: i64| {
            let id = new_trade(&conn);
            put(&conn, id, MINE, "bolt", "foil", quantity);
            let owned = trade(&conn, id).lines[0].owned;
            let options = TradeFinishOptions {
                remove_given: true,
                ..NONE
            };
            let done = finish_trade(&conn, id, &options).unwrap();
            (owned, done.removed_from_collection)
        };

        // Two given, seven real copies held: the binder's plain pair goes, though five rows
        // sit ahead of it at the root.
        assert_eq!(give(2), (7, 2), "the five proxies are not owned");
        assert_eq!(
            left(),
            [
                (1, false),
                (1, false),
                (1, false),
                (1, false),
                (1, false),
                (5, true)
            ],
            "every copy that is one object is still there"
        );
        assert_eq!(held(&conn, "bolt", "foil", Some(folder)), 0);
        let (price, notes): (Option<f64>, Option<String>) = conn
            .query_row(
                "SELECT purchase_price, notes FROM collection_entries WHERE signed = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(price, Some(80.0));
        assert_eq!(notes.as_deref(), Some("signed at the prerelease"));

        // Nine given, five held, none of them plain: the reader asked for that many and was
        // told five, so the five go. The proxies stay.
        assert_eq!(give(9), (5, 5));
        assert_eq!(left(), [(5, true)]);
        assert_eq!(give(1), (0, 0), "and a proxy alone is nothing to give");
        assert_eq!(left(), [(5, true)]);
    }

    /// Step 1 once more, for the tradelist. The copies that left in a trade are the ones the
    /// tradelist was promising, so it falls by the copies taken — to nothing and no further —
    /// rather than staying as high as the row still allows.
    #[test]
    fn finishing_spends_the_tradelist_of_a_row_it_takes_copies_from() {
        let conn = seeded();
        let id = new_trade(&conn);
        let listed = |card_id: &str, finish: &str, quantity: i64, tradelist: i64| {
            add_entry(
                &conn,
                &EntryInput {
                    card_id: card_id.to_owned(),
                    finish: finish.to_owned(),
                    quantity,
                    tradelist_quantity: tradelist,
                    ..Default::default()
                },
            )
            .unwrap();
        };
        // Four with two for trade, giving two: a clamp would leave both kept copies listed.
        listed("bolt", "nonfoil", 4, 2);
        put(&conn, id, MINE, "bolt", "nonfoil", 2);
        // Five with four for trade, giving one: three are still on offer.
        listed("goyf", "nonfoil", 5, 4);
        put(&conn, id, MINE, "goyf", "nonfoil", 1);
        // Five with one for trade, giving three: spent, and never below nothing.
        listed("charm", "foil", 5, 1);
        put(&conn, id, MINE, "charm", "foil", 3);
        // Not on the trade at all: left exactly as it was.
        listed("bolt", "foil", 3, 3);

        let options = TradeFinishOptions {
            remove_given: true,
            ..NONE
        };
        assert_eq!(
            finish_trade(&conn, id, &options)
                .unwrap()
                .removed_from_collection,
            6
        );

        let rows: Vec<(String, String, i64, i64)> = conn
            .prepare(
                "SELECT card_id, finish, quantity, tradelist_quantity
                   FROM collection_entries ORDER BY id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            [
                ("bolt".to_owned(), "nonfoil".to_owned(), 2, 0),
                ("goyf".to_owned(), "nonfoil".to_owned(), 4, 3),
                ("charm".to_owned(), "foil".to_owned(), 2, 0),
                ("bolt".to_owned(), "foil".to_owned(), 3, 3),
            ]
        );
    }

    /// Step 1 last, for a deck's copies: taken only for what the copies outside decks leave
    /// owed — a signed copy in a binder goes before a plain one in a deck — and counted apart.
    /// **The deck is not told.** Its list still names the card and its history has no row; what
    /// changes is what it reads as owned, which is the collection's own removal of such a row.
    #[test]
    fn finishing_takes_a_decks_copies_last_and_leaves_its_list_alone() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 6);
        // Burn lists four Bolts and holds three of them, two on the tradelist; Storm holds two.
        let (burn, burn_group) = deck_and_group(&conn, "Burn");
        let (_, storm_group) = deck_and_group(&conn, "Storm");
        let main = crate::schema::fixtures::category(&conn, burn, "main", "Main deck");
        // `finish` NULL is the printing's own, which for this Bolt is nonfoil.
        conn.execute(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, finish, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'live', 'bolt', 'tst', 'bolt', 'en', 'Lightning Bolt', NULL,
                     4, unixepoch(), unixepoch())",
            params![burn, main],
        )
        .unwrap();
        sleeve(&conn, "bolt", "nonfoil", 3, burn_group, |e| {
            e.tradelist_quantity = 2
        });
        sleeve(&conn, "bolt", "nonfoil", 2, storm_group, |_| {});
        // Four outside any deck: one loose, two in a binder and a signed one beside them.
        let folder = binder(&conn, "Binder");
        own(&conn, "bolt", "nonfoil", 1, None);
        own(&conn, "bolt", "nonfoil", 2, Some(folder));
        add_entry(
            &conn,
            &EntryInput {
                card_id: "bolt".to_owned(),
                finish: "nonfoil".to_owned(),
                quantity: 1,
                folder_id: Some(folder),
                signed: true,
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute("DELETE FROM activity", []).unwrap();
        let held_by_line = || {
            let line = trade(&conn, id).lines.remove(0);
            (line.owned, line.owned_in_decks, line.deck_names)
        };
        let decks = vec!["Burn".to_owned(), "Storm".to_owned()];
        let burn_owns = || -> i64 {
            crate::deck::get_deck(&conn, burn, "live", Marketplace::default())
                .unwrap()
                .expect("the deck is there")
                .cards
                .iter()
                .map(|card| card.owned_quantity)
                .sum()
        };
        assert_eq!(held_by_line(), (4, 5, decks.clone()));
        assert_eq!(burn_owns(), 3);

        let options = TradeFinishOptions {
            remove_given: true,
            ..NONE
        };
        let done = finish_trade(&conn, id, &options).unwrap();

        // Six asked for: all four outside, and the two still owed out of the older deck row.
        assert_eq!(
            done,
            TradeOutcome {
                removed_from_collection: 6,
                removed_from_decks: 2,
                ..Default::default()
            }
        );
        assert_eq!(trade(&conn, id).outcome, Some(done));
        assert_eq!(held(&conn, "bolt", "nonfoil", None), 0);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(folder)), 0);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(burn_group)), 1);
        assert_eq!(held(&conn, "bolt", "nonfoil", Some(storm_group)), 2);
        assert_eq!(held_by_line(), (0, 3, decks));
        // The tradelist of a deck's row is spent like any other's.
        let listed: i64 = conn
            .query_row(
                "SELECT tradelist_quantity FROM collection_entries WHERE folder_id = ?1",
                params![burn_group],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(listed, 0);

        // Burn still lists its four and now holds one of them, and nothing was written to it.
        let on_the_list: i64 = conn
            .query_row(
                "SELECT quantity FROM deck_cards WHERE deck_id = ?1 AND card_id = 'bolt'",
                params![burn],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(on_the_list, 4);
        assert_eq!(burn_owns(), 1);
        assert!(crate::deck_audit::list(&conn, burn, 50).unwrap().is_empty());
        // One feed row, the step's, in the shape it always had: one card, from several places.
        assert_eq!(
            feed(&conn),
            [(
                "collection".to_owned(),
                "remove".to_owned(),
                Some("Lightning Bolt".to_owned()),
                json!({ "folder": null }),
                -6
            )]
        );
    }

    /// `trades.outcome` outlives the build that wrote it. One stored before a finish could
    /// reach a deck has no `removedFromDecks`, reads as none, and is added to like any other.
    #[test]
    fn an_outcome_stored_before_decks_could_be_traded_reads_as_none_from_decks() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 1);
        sleeve(&conn, "bolt", "nonfoil", 1, deck_group(&conn), |_| {});
        conn.execute(
            "UPDATE trades SET finished_before = 1, outcome = ?2 WHERE id = ?1",
            params![
                id,
                r#"{"removedFromCollection":3,"addedToCollection":3,"removedFromWishlist":1,"addedToWishlist":0}"#
            ],
        )
        .unwrap();
        let before = TradeOutcome {
            removed_from_collection: 3,
            added_to_collection: 3,
            removed_from_wishlist: 1,
            ..Default::default()
        };
        assert_eq!(trade(&conn, id).outcome, Some(before));

        let options = TradeFinishOptions {
            remove_given: true,
            ..NONE
        };
        let done = finish_trade(&conn, id, &options).unwrap();
        assert_eq!(
            (done.removed_from_collection, done.removed_from_decks),
            (1, 1),
            "the only copy there is, and it is a deck's"
        );
        assert_eq!(
            trade(&conn, id).outcome,
            Some(TradeOutcome {
                removed_from_collection: 4,
                removed_from_decks: 1,
                ..before
            })
        );
        // And the key is on the wire under the name the page reads.
        assert_eq!(serde_json::to_value(done).unwrap()["removedFromDecks"], 1);
    }

    /// Step 2. Received cards are added where the dialog said, folding into what is there — and
    /// a folder that is not the reader's refuses the whole finish.
    #[test]
    fn finishing_adds_received_cards_to_the_folder_named() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, THEIRS, "goyf", "etched", 2);
        put(&conn, id, THEIRS, "bolt", "foil", 1);
        put(&conn, id, MINE, "charm", "foil", 1);
        let folder = binder(&conn, "Trades");
        own(&conn, "goyf", "etched", 1, Some(folder));
        conn.execute("DELETE FROM activity", []).unwrap();

        // A deck's group is not somewhere a reader's add may file, and the refusal leaves the
        // trade open with nothing added.
        let group = deck_group(&conn);
        let err = finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                add_received: true,
                folder_id: Some(group),
                ..NONE
            },
        )
        .unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(trade(&conn, id).status, OPEN);
        assert_eq!(held(&conn, "bolt", "foil", Some(group)), 0);
        assert!(feed(&conn).is_empty(), "a refused finish says nothing");

        let done = finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                add_received: true,
                folder_id: Some(folder),
                ..NONE
            },
        )
        .unwrap();
        assert_eq!(done.added_to_collection, 3);
        assert_eq!(held(&conn, "goyf", "etched", Some(folder)), 3);
        assert_eq!(held(&conn, "bolt", "foil", Some(folder)), 1);
        assert_eq!(
            held(&conn, "charm", "foil", Some(folder)),
            0,
            "mine is not received"
        );
        assert_eq!(
            feed(&conn),
            [(
                "collection".to_owned(),
                "import".to_owned(),
                None,
                json!({ "cards": 3, "rows": 2, "trade": true }),
                3
            )]
        );
    }

    /// A step about one card reads as that card's own line in the feed — with the folder it
    /// went into, or came out of.
    #[test]
    fn a_step_about_one_card_is_recorded_as_that_card() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 2);
        put(&conn, id, THEIRS, "goyf", "foil", 1);
        let folder = binder(&conn, "Binder A");
        own(&conn, "bolt", "nonfoil", 2, Some(folder));
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("goyf".to_owned()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute("DELETE FROM activity", []).unwrap();

        finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                folder_id: Some(folder),
                wish_given: false,
                ..ALL
            },
        )
        .unwrap();

        let mut rows = feed(&conn);
        rows.reverse();
        assert_eq!(
            rows,
            [
                (
                    "collection".to_owned(),
                    "remove".to_owned(),
                    Some("Lightning Bolt".to_owned()),
                    json!({ "folder": "Binder A" }),
                    -2
                ),
                (
                    "collection".to_owned(),
                    "add".to_owned(),
                    Some("Tarmogoyf".to_owned()),
                    json!({ "folder": "Binder A", "finish": "foil" }),
                    1
                ),
                (
                    "wishlist".to_owned(),
                    "remove".to_owned(),
                    Some("Tarmogoyf".to_owned()),
                    json!({ "folder": null }),
                    -1
                ),
            ]
        );
    }

    /// Step 3. Received cards come off the wishes for the card — this printing's first — up to
    /// the copies received, and a managed wishlist's wish is never one of them.
    #[test]
    fn finishing_takes_received_cards_off_the_wishes_for_them() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, THEIRS, "bolt-2", "nonfoil", 3);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 1);
        // Oldest first: the any-printing wish, then the one for this exact printing. The exact
        // one is taken first all the same.
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-bolt".to_owned()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-2".to_owned()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        managed_wish(&conn, "bolt-2", "o-bolt", 9);
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("goyf".to_owned()),
                quantity: 5,
                preferred_finish: Some("foil".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute("DELETE FROM activity", []).unwrap();

        let done = finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                unwish_received: true,
                ..NONE
            },
        )
        .unwrap();

        assert_eq!(done.removed_from_wishlist, 4, "three Bolts and one Goyf");
        assert_eq!(
            wishes(&conn),
            [
                // Two of its four went, after the pinned wish's one.
                (None, None, 2),
                // The managed wish, untouched.
                (Some("bolt-2".to_owned()), None, 9),
                (Some("goyf".to_owned()), Some("foil".to_owned()), 4),
            ]
        );
        assert_eq!(
            feed(&conn),
            [(
                "wishlist".to_owned(),
                "clear".to_owned(),
                None,
                json!({ "cards": 4, "trade": true }),
                -4
            )]
        );
    }

    /// Step 4. Each card given becomes a wish for that printing in that finish, at the root,
    /// with one feed row for the run.
    #[test]
    fn finishing_wishes_for_the_cards_given_in_the_printing_and_finish_that_left() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "foil", 2);
        put(&conn, id, MINE, "goyf", "nonfoil", 1);
        put(&conn, id, THEIRS, "charm", "foil", 1);
        conn.execute("DELETE FROM activity", []).unwrap();

        let done = finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                wish_given: true,
                ..NONE
            },
        )
        .unwrap();

        assert_eq!(done.added_to_wishlist, 3);
        assert_eq!(
            wishes(&conn),
            [
                (Some("bolt".to_owned()), Some("foil".to_owned()), 2),
                (Some("goyf".to_owned()), Some("nonfoil".to_owned()), 1),
            ]
        );
        assert_eq!(
            feed(&conn),
            [(
                "wishlist".to_owned(),
                "add".to_owned(),
                None,
                json!({ "cards": 3, "rows": 2, "folder": null }),
                3
            )]
        );
    }

    /// A finish closes the trade with the prices it had: the frozen figure stays when the live
    /// one moves, the outcome is stored and answered, and the trade can no longer be written.
    #[test]
    fn a_finished_trade_keeps_its_prices_and_its_outcome_and_refuses_every_write() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "foil", 1);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 2);
        own(&conn, "bolt", "foil", 1, None);

        let done = finish_trade(&conn, id, &ALL).unwrap();
        assert_eq!(
            done,
            TradeOutcome {
                removed_from_collection: 1,
                removed_from_decks: 0,
                added_to_collection: 2,
                removed_from_wishlist: 0,
                added_to_wishlist: 1,
            }
        );
        conn.execute(
            r#"UPDATE cards SET prices = '{"usd":"99.00","usd_foil":"99.00"}'"#,
            [],
        )
        .unwrap();

        let closed = trade(&conn, id);
        assert_eq!(closed.status, FINISHED);
        assert!(closed.finished_before);
        assert!(closed.closed_at.is_some());
        assert_eq!(closed.outcome, Some(done));
        assert_eq!(
            closed
                .lines
                .iter()
                .map(|l| l.unit_price)
                .collect::<Vec<_>>(),
            [Some(9.0), Some(20.0)],
            "what it closed with"
        );
        assert_eq!(
            closed.lines[0].finish_prices.foil,
            Some(99.0),
            "the finish hints stay live"
        );
        assert_eq!(
            list_trades(&conn).unwrap()[0].lines[0].unit_price,
            Some(9.0)
        );

        let line = closed.lines[0].id;
        let refusals = [
            rename_trade(&conn, id, "Later").unwrap_err(),
            set_trade_rate(&conn, id, MINE, 80).unwrap_err(),
            add_trade_lines(&conn, id, MINE, &[input("goyf", "foil", 1, "search")]).unwrap_err(),
            update_trade_line(
                &conn,
                line,
                &TradeLineChange {
                    quantity: Some(4),
                    ..Default::default()
                },
            )
            .unwrap_err(),
            remove_trade_line(&conn, line).unwrap_err(),
            finish_trade(&conn, id, &ALL).unwrap_err(),
            archive_trade(&conn, id).unwrap_err(),
        ];
        for refusal in refusals {
            assert_eq!(refusal, NOT_OPEN);
        }
        let after = trade(&conn, id);
        assert_eq!(after.name, format!("Trade {id}"));
        assert_eq!(after.lines.len(), 2);
        assert_eq!(
            held(&conn, "goyf", "nonfoil", None),
            2,
            "and the finish ran once"
        );
    }

    /// An empty trade can be finished, and a finish with every box off closes the trade and
    /// touches nothing else.
    #[test]
    fn a_finish_with_nothing_to_do_closes_the_trade_and_touches_nothing() {
        let conn = seeded();
        let empty = new_trade(&conn);
        assert_eq!(
            finish_trade(&conn, empty, &ALL).unwrap(),
            TradeOutcome::default()
        );
        assert_eq!(trade(&conn, empty).status, FINISHED);

        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 1);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 1);
        own(&conn, "bolt", "nonfoil", 1, None);
        conn.execute("DELETE FROM activity", []).unwrap();
        // What a request that names no step deserialises to.
        let unsaid: TradeFinishOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(
            finish_trade(&conn, id, &unsaid).unwrap(),
            TradeOutcome::default()
        );
        assert_eq!(held(&conn, "bolt", "nonfoil", None), 1);
        assert_eq!(held(&conn, "goyf", "nonfoil", None), 0);
        assert!(wishes(&conn).is_empty());
        assert!(feed(&conn).is_empty());
        assert_eq!(trade(&conn, id).outcome, Some(TradeOutcome::default()));
    }

    /// Archiving freezes the prices and nothing else: no card moves, no finish is recorded.
    #[test]
    fn archiving_freezes_the_prices_and_leaves_the_collection_alone() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 1);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 1);
        own(&conn, "bolt", "nonfoil", 1, None);
        conn.execute("DELETE FROM activity", []).unwrap();

        archive_trade(&conn, id).unwrap();
        conn.execute(r#"UPDATE cards SET prices = '{"usd":"99.00"}'"#, [])
            .unwrap();

        let archived = trade(&conn, id);
        assert_eq!(archived.status, ARCHIVED);
        assert!(!archived.finished_before);
        assert_eq!(archived.outcome, None);
        assert!(archived.closed_at.is_some());
        assert_eq!(
            archived
                .lines
                .iter()
                .map(|l| l.unit_price)
                .collect::<Vec<_>>(),
            [Some(2.0), Some(20.0)]
        );
        assert_eq!(held(&conn, "bolt", "nonfoil", None), 1);
        assert_eq!(held(&conn, "goyf", "nonfoil", None), 0);
        assert!(feed(&conn).is_empty());
        assert_eq!(archive_trade(&conn, id).unwrap_err(), NOT_OPEN);
    }

    /// A reopen puts the trade back on live prices and undoes nothing a finish did: the trade
    /// remembers it was finished, and a second finish adds to what the first recorded.
    #[test]
    fn reopening_clears_the_frozen_prices_and_keeps_the_record_of_the_finish() {
        let conn = seeded();
        let id = new_trade(&conn);
        put(&conn, id, MINE, "bolt", "nonfoil", 1);
        put(&conn, id, THEIRS, "goyf", "nonfoil", 1);
        own(&conn, "bolt", "nonfoil", 3, None);
        let first = finish_trade(&conn, id, &ALL).unwrap();
        conn.execute(r#"UPDATE cards SET prices = '{"usd":"5.00"}'"#, [])
            .unwrap();

        reopen_trade(&conn, id).unwrap();
        // Twice is once.
        reopen_trade(&conn, id).unwrap();

        let open = trade(&conn, id);
        assert_eq!(open.status, OPEN);
        assert_eq!(open.closed_at, None);
        assert!(open.finished_before);
        assert_eq!(open.outcome, Some(first));
        assert_eq!(
            open.lines.iter().map(|l| l.unit_price).collect::<Vec<_>>(),
            [Some(5.0), Some(5.0)],
            "live again"
        );
        let frozen: i64 = conn
            .query_row(
                "SELECT count(*) FROM trade_lines WHERE unit_price IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(frozen, 0);
        assert_eq!(
            held(&conn, "bolt", "nonfoil", None),
            2,
            "nothing was put back"
        );
        assert_eq!(held(&conn, "goyf", "nonfoil", None), 1);

        // It is editable again, and a second finish that takes one more Bolt is added to the
        // first's record while answering only for itself.
        rename_trade(&conn, id, "  ").unwrap();
        assert_eq!(trade(&conn, id).name, format!("Trade {id}"));
        rename_trade(&conn, id, "Second pass").unwrap();
        let second = finish_trade(
            &conn,
            id,
            &TradeFinishOptions {
                remove_given: true,
                ..NONE
            },
        )
        .unwrap();
        assert_eq!(second.removed_from_collection, 1);
        assert_eq!(second.added_to_collection, 0);
        let again = trade(&conn, id);
        assert_eq!(again.name, "Second pass");
        assert_eq!(again.outcome, Some(first.plus(second)));
        assert_eq!(again.outcome.unwrap().removed_from_collection, 2);

        assert_eq!(reopen_trade(&conn, 999).unwrap_err(), GONE);
    }

    /// A copy is a new open trade with the same lines, percentages and marketplace, and none of
    /// what made the original a closed one.
    #[test]
    fn a_duplicate_is_an_open_trade_with_the_same_lines_and_no_history() {
        let conn = seeded();
        let id = create_trade(
            &conn,
            &TradeCreate {
                name: Some("Store night".to_owned()),
                marketplace: Some("cardmarket".to_owned()),
            },
        )
        .unwrap();
        add_trade_lines(&conn, id, MINE, &[input("bolt", "foil", 2, "collection")]).unwrap();
        add_trade_lines(&conn, id, THEIRS, &[input("goyf", "nonfoil", 1, "scan")]).unwrap();
        add_trade_lines(&conn, id, MINE, &[input("charm", "foil", 1, "search")]).unwrap();
        set_trade_rate(&conn, id, THEIRS, 80).unwrap();
        finish_trade(&conn, id, &NONE).unwrap();
        conn.execute(
            r#"UPDATE cards SET prices = '{"eur":"3.00","eur_foil":"8.00"}' WHERE id = 'bolt'"#,
            [],
        )
        .unwrap();

        let copy = duplicate_trade(&conn, id).unwrap();
        assert_ne!(copy, id);
        let (original, copied) = (trade(&conn, id), trade(&conn, copy));
        assert_eq!(copied.name, "Store night copy");
        assert_eq!(copied.marketplace, "cardmarket");
        assert_eq!((copied.rate_mine, copied.rate_theirs), (100, 80));
        assert_eq!(copied.status, OPEN);
        assert!(!copied.finished_before);
        assert_eq!(copied.outcome, None);
        assert_eq!(copied.closed_at, None);
        let shape = |t: &Trade| -> Vec<(String, String, String, i64, String)> {
            t.lines
                .iter()
                .map(|l| {
                    (
                        l.side.clone(),
                        l.card_id.clone(),
                        l.finish.clone(),
                        l.quantity,
                        l.source.clone(),
                    )
                })
                .collect()
        };
        assert_eq!(shape(&copied), shape(&original));
        assert_eq!(shape(&copied).len(), 3);
        assert_eq!(
            original.lines[0].unit_price,
            Some(7.0),
            "the original keeps its figure"
        );
        assert_eq!(copied.lines[0].unit_price, Some(8.0), "the copy is live");
        assert_eq!(original.status, FINISHED);

        assert_eq!(duplicate_trade(&conn, 999).unwrap_err(), GONE);
        assert_eq!(list_trades(&conn).unwrap().len(), 2);
    }

    /// A delete takes the lines with the trade — by its own statement, so it holds on a
    /// connection that never turned `foreign_keys` on — and a line or a trade that is already
    /// gone is not an error.
    #[test]
    fn deleting_a_trade_deletes_its_lines_whatever_the_connection_enforces() {
        let conn = crate::schema::memory_pair();
        card(
            &conn,
            "bolt",
            "o-bolt",
            "Lightning Bolt",
            r#"["nonfoil"]"#,
            "{}",
        );
        let keep = new_trade(&conn);
        let id = new_trade(&conn);
        put(&conn, keep, MINE, "bolt", "nonfoil", 1);
        put(&conn, id, MINE, "bolt", "nonfoil", 1);
        put(&conn, id, THEIRS, "bolt", "nonfoil", 2);
        let line = line_id(&conn, id, MINE, "bolt", "nonfoil");

        remove_trade_line(&conn, line).unwrap();
        remove_trade_line(&conn, line).unwrap();
        assert!(side(&conn, id, MINE).is_empty());

        // A finished trade can be deleted too.
        finish_trade(&conn, id, &NONE).unwrap();
        delete_trade(&conn, id).unwrap();
        delete_trade(&conn, id).unwrap();
        assert!(get_trade(&conn, id).unwrap().is_none());
        let orphans: i64 = conn
            .query_row(
                "SELECT count(*) FROM trade_lines WHERE trade_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
        assert_eq!(side(&conn, keep, MINE).len(), 1, "the other trade is whole");
        assert_eq!(rename_trade(&conn, id, "Gone").unwrap_err(), GONE);
    }
}
