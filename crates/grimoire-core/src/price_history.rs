//! What the reader's cards cost on each day this app has looked — and which of them moved.
//!
//! **The home page's Price movers widget, both halves, and the detail a mover opens**:
//! [`snapshot`] records today's price for every printing the collection owns, in every priced
//! marketplace, into `price_snapshots` (user schema v45) — and, since v50, how many copies of it
//! were held that day; [`movers`] compares today's live price against the snapshot a window ago;
//! [`history`] answers one printing's every kept snapshot, for the chart in that detail. The
//! third only reads what the first wrote, so the rules below are its too, and so are they
//! [`crate::value_history`]'s, which reads the same table for the Collection value graph.
//!
//! # The rules
//!
//! * **Every price is `sorting::price_expr`'s**, the crate's one price builder, at the copy's own
//!   finish — through `sorting::held_price_expr` for an owned copy, as the collection page reads
//!   it, so a `nonfoil` copy of a printing not sold in nonfoil is that printing's price. So a
//!   snapshot is exactly the number the collection page showed that day, the etched hole in
//!   Cardmarket and a feed that does not quote a printing included — and an unpriced finish is a
//!   **NULL**, never a zero.
//! * **A row is a holding, not a price (user schema v50).** Every printing the reader holds gets
//!   its row, priced or not, so a card whose price starts or stops being quoted stays in the
//!   table and [`crate::value_history`] reads that as a price moving rather than as a card
//!   arriving or leaving.
//! * **…or a printing the reader is watching, at `copies = 0` (issue #906).** The Price movers
//!   widget can be narrowed to wishlist folders and to cards the reader does not own, and a
//!   printing with no history has nothing to move against — so a snapshot also records every
//!   printing a wish pins ([`wished_printings`]) and every card on the device's watch list
//!   ([`watched`]), **priced rows only**, with no copies. Such a row is never a holding:
//!   [`crate::value_history`] reads only `copies > 0`, and a printing both owned and watched is
//!   one row carrying its owned count. [`movers`] and [`history`] read a watched row exactly as
//!   an owned one, because a price is a fact about the printing and not about who holds it.
//! * **Every reader in this module skips a NULL-price row exactly as it skipped an absent one**
//!   — never a mover, a baseline, a history point or a day held — and the thinning never lets
//!   one displace a priced row a reader here would have kept (see [`prune`]).
//!   **One exception, per marketplace per day: a marketplace that prices none of the held
//!   printings writes nothing.** That is a feed the reader never selected, and its rows would say
//!   nothing while doubling the table — and, worse, would make the day the feed first arrives read
//!   as the whole collection's value appearing in one price move. A missing day is a gap in that
//!   marketplace's line and never a step, because a period is only ever made from rows.
//! * **The day comes from SQLite's `date('now')`, UTC** — read **once** per snapshot and bound
//!   into every statement it makes. A calendar day is the key, and **a snapshot replaces its
//!   marketplace's whole day** — so the day holds its last snapshot's prices and holding and
//!   nothing older: a printing sold between a sync and a feed refresh on one afternoon has no row
//!   that day, where an insert-or-replace would have left the morning's. **Replaced, not
//!   rewritten**: each marketplace deletes the rows of its
//!   day the new holding does not contain, then upserts the rest, and a row whose price and copies
//!   already say the same is not touched. The rule was once kept by deleting the whole day and
//!   inserting it again, which rewrote every row — a few thousand — on every launch, ingest and
//!   feed store, for a day in which usually nothing had moved. On a thousand held printings in
//!   three priced marketplaces that was 3 000 rows and ~320 KB of WAL a snapshot; an unchanged one
//!   now writes no row and no WAL frame, in about the same ~30 ms (debug build, Linux, file-backed
//!   WAL, 2026-09-27 — the one figure here not taken on Windows).
//!   `a_snapshot_that_changes_nothing_writes_nothing` pins the zero.
//! * **A marketplace is the *priced* one**: [`crate::marketplace::MARKETPLACE_IDS`] mapped through
//!   [`Marketplace::from_id`], so `cardtrader` — which quotes TCGplayer — is not a key of its own
//!   and cannot store a second copy of every TCGplayer row. [`market_key`] is the spelling.
//! * **…and the wishlist's holding, beside it (user schema v66).** A watched row has no
//!   quantity and an any-printing wish no printing, so the Wishlist value graph cannot be read
//!   from `price_snapshots`: the same snapshot, in the same transaction and by the same rules —
//!   one day replaced, only the difference written, the same gate, the same thinning — records
//!   every wish into `wish_snapshots` at the price the Wishlist value widget quotes it
//!   ([`crate::wishlist::holding_sql`]). [`crate::value_history`] reads both tables.
//! * **It is best-effort, everywhere it is called.** A missed day is a gap in a widget; nothing
//!   that calls [`snapshot`] may fail because of it, and each caller logs or records the error and
//!   carries on. Three callers: the launch (`maintenance::snapshot_prices`), a card ingest
//!   (`sync.rs`, beside `last_ingest_at`) and a feed store (`marketplace_feed::store`, for that one
//!   marketplace).
//!
//! # `WITHOUT ROWID`, and the fence it steps outside
//!
//! `db::CrossFileFence` rides in the update hook, which does not fire for `WITHOUT ROWID` tables,
//! so it cannot see a write here. **That is safe by construction rather than by care**: [`snapshot`]
//! and [`snapshot_market`] open a transaction of their own, and SQLite refuses `BEGIN` inside an
//! open one — so neither can ever be the user-file half of a transaction that also wrote the
//! corpus. `a_snapshot_refuses_to_run_inside_someone_elses_transaction` pins it. What the shape
//! buys is a key stored twice rather than three times (row, rowid autoindex, secondary index), on
//! the one user table that grows by a few thousand rows a day, and no per-row hook callback on
//! a write the mirror maps to nothing anyway.
//!
//! # How long it is kept, and why not every day of it
//!
//! [`prune`] deletes everything older than [`KEEP_DAYS`] and **thins** everything older than
//! [`DAILY_DAYS`] to the latest row per printing per seven-day bucket. **A measurement decided
//! it**: a thousand owned printings in two priced marketplaces is two thousand rows a day, and 400
//! daily days of this table's exact shape measured **800 000 rows and 114.7 MB** after a `VACUUM`;
//! thinned, the same history is **176 000 rows and 25.3 MB** (2026-09-15, Node 24's bundled
//! SQLite, random UUID card ids). `user.db` is 1–2 MB today and is the file this app calls the
//! reader's, on a USB stick. Nothing the widget asks is lost: its 7-day and 30-day baselines read
//! the daily band, and `all` reads the oldest surviving row.
//!
//! Thinning runs **on the first snapshot of a calendar day** — decided before that snapshot
//! deletes anything, since the delete is what empties the day — and weighs **only the rows that
//! crossed the daily horizon since the previous snapshot day**: a row can only cross when the
//! date changes, and the survivors of a bucket are its newest rows, so each row needs weighing
//! once. [`prune`] carries the measurement that made the floor necessary.
//!
//! # Movers, and the two sentences they must keep apart
//!
//! A mover is an owned, priced printing — or, under a [`PriceMoverScope`], a printing the scope
//! names — whose live price differs from its baseline: the latest
//! priced snapshot on or before `date('now', '-7 days')` (or `-30 days`), or for `all` the oldest
//! priced snapshot before today — a NULL-price row is no baseline, as an absent one was not.
//! **There is no fallback to a younger baseline** — a window with no snapshot old enough answers
//! no movers and `since: null`, which is the widget's "no history yet". `since` is
//! the newest baseline day across every printing that *has* one, **before** zero moves and the
//! direction are filtered out: computed over the returned movers instead, a window in which
//! nothing moved would also answer `null`, and "nothing moved" would read as "no history yet" —
//! the one confusion the contract names. `days` is how many distinct days this marketplace holds.

use crate::collection_source::{self, Availability};
use crate::sorting::{self, Marketplace};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Nothing older than this many days survives a [`prune`] — a year and a month, so `all` can
/// always reach back past the same week last year.
pub const KEEP_DAYS: i64 = 400;

/// Every day's row is kept for this many days; older rows are thinned to one per printing per
/// seven-day bucket. Five weeks, so the 30-day baseline always has a daily row to land on.
pub const DAILY_DAYS: i64 = 35;

/// The most movers one read answers, and the ceiling a request is clamped to.
pub const MAX_LIMIT: i64 = 100;

/// `price_snapshots.marketplace` for a priced marketplace.
///
/// **Written out rather than derived from the enum's name**, `sorting`'s own rule for its feed
/// ids: a rename in Rust must not silently stop matching rows a snapshot already wrote. Each is
/// one of [`crate::marketplace::MARKETPLACE_IDS`], which
/// `every_marketplace_id_maps_to_one_priced_key` holds it to.
pub fn market_key(market: Marketplace) -> &'static str {
    match market {
        Marketplace::Tcgplayer => "tcgplayer",
        Marketplace::Cardmarket => "cardmarket",
        Marketplace::Cardkingdom => "cardkingdom",
        Marketplace::Manapool => "manapool",
    }
}

/// Every marketplace the setting knows, reduced to the ones that price differently — in the
/// picker's order, each once.
pub fn priced_markets() -> Vec<Marketplace> {
    let mut out: Vec<Marketplace> = Vec::new();
    for id in crate::marketplace::MARKETPLACE_IDS {
        let market = Marketplace::from_id(id);
        if !out.contains(&market) {
            out.push(market);
        }
    }
    out
}

/// The `app_meta` key of the device's price watch list — a JSON array of printing ids.
///
/// **Device-local, like the home layout it is derived from** (`app_meta` is in no
/// `SYNCED_TABLES` entry): the page writes it from the cards its Price movers widgets are
/// narrowed to, so it says which printings this device's snapshots should remember a price for
/// and nothing else. It is an index of the layout, not a second source of truth — the widget
/// config is what the reader chose, and this is how Rust, which never reads a widget's config,
/// is told.
pub const K_PRICE_WATCH: &str = "price_watch";

/// The most printings the watch list holds. Each one is a row a day in every marketplace that
/// prices it, so the list is bounded the way [`KEEP_DAYS`] bounds the days.
pub const MAX_WATCHED: usize = 500;

/// What [`set_watched`] says about a list past [`MAX_WATCHED`].
pub const TOO_MANY_WATCHED: &str =
    "That is too many cards to follow prices for. Choose 500 or fewer.";

/// The printings on the device's watch list, in the order they were written. A missing row, an
/// unreadable one and an entry that is not a string all read as nothing — `app_meta`'s rule: a
/// lost index costs a few days of history and is rewritten by the page's next layout change.
pub fn watched(conn: &Connection) -> Vec<String> {
    crate::app_meta::get_app_meta(conn, K_PRICE_WATCH)
        .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .filter(|id| !id.trim().is_empty())
        .take(MAX_WATCHED)
        .collect()
}

/// Replace the watch list. Blank ids are dropped and a repeated one is kept once, at its first
/// place; more than [`MAX_WATCHED`] distinct ids is refused in words rather than cut, so a page
/// that asked for a card is never quietly told yes. **Writes nothing when the list is
/// unchanged**, since the page sends it on every layout change that touches a Price movers
/// widget — and answers whether it wrote, which is what [`watch`] asks.
pub fn set_watched(conn: &Connection, card_ids: &[String]) -> Result<bool, String> {
    let mut list: Vec<&str> = Vec::new();
    for id in card_ids.iter().map(|id| id.trim()) {
        if !id.is_empty() && !list.contains(&id) {
            list.push(id);
        }
    }
    if list.len() > MAX_WATCHED {
        return Err(TOO_MANY_WATCHED.to_owned());
    }
    if watched(conn) == list {
        return Ok(false);
    }
    let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    crate::app_meta::set_app_meta(conn, K_PRICE_WATCH, &json).map_err(|e| e.to_string())?;
    Ok(true)
}

/// `set_price_watch`: [`set_watched`], and — when the list changed — today's [`snapshot`] at
/// once (issue #1080).
///
/// **A card chosen now has its first price recorded now.** The snapshot's three callers are the
/// launch, an ingest and a feed refresh, so before this a card chosen mid-session waited for the
/// next of those to be remembered at all — on a desktop left open, days — and every window's
/// baseline waited with it, while the widget said *no price history yet* and looked broken. A
/// snapshot that changes nothing writes nothing, so a list that only dropped a card costs a read.
///
/// **Best-effort, the module's rule**: the list is stored whatever the snapshot does, and a
/// snapshot that fails is logged and left to the next launch, ingest or feed refresh.
pub fn watch(conn: &Connection, card_ids: &[String]) -> Result<(), String> {
    if set_watched(conn, card_ids)? {
        if let Err(e) = snapshot(conn) {
            eprintln!(
                "today's prices of the followed cards could not be recorded: {e}\nThe next \
                 launch, sync or price refresh records them; nothing else is affected."
            );
        }
    }
    Ok(())
}

/// Every finish there is, as a JSON array literal for `json_each` — what a wish with no
/// preferred finish and a watched card are tracked in. A finish a printing is not made in is
/// simply never priced, and every reader here drops an unpriced row.
fn every_finish() -> String {
    format!("'[\"{}\"]'", crate::schema::FINISHES.join("\",\""))
}

/// `(card_id, finish)` for every printing a wish pins, narrowed by `filter` (an `AND …` over
/// `wishlist_entries w`, or empty). **An any-printing wish is no printing** and is left out: it
/// has no price of its own to have moved. A wish with no preferred finish is a wish for the card
/// and is tracked in every finish — `wishlist::WISH_PREFERRED_FINISH`'s reading, which refuses to
/// treat "no preference" as nonfoil.
fn wished_printings(filter: &str) -> String {
    format!(
        "SELECT w.card_id AS card_id, f.value AS finish
           FROM wishlist_entries w,
                json_each(CASE WHEN w.preferred_finish IS NULL THEN {every}
                               ELSE json_array(w.preferred_finish) END) f
          WHERE w.card_id IS NOT NULL{filter}",
        every = every_finish(),
    )
}

/// `(card_id, finish)` for every printing in the JSON array bound at `param`, in every finish.
/// An entry that is not a string is skipped rather than refused.
fn listed_printings(param: &str) -> String {
    format!(
        "SELECT j.value AS card_id, f.value AS finish
           FROM json_each({param}) j, json_each({every}) f
          WHERE j.type = 'text'",
        every = every_finish(),
    )
}

/// Record today's price for every owned printing in every priced marketplace, then keep the
/// history inside its bounds.
///
/// **Answers how many of today's rows the snapshot changed** — inserted, updated or deleted, the
/// sum of `changes()` over each marketplace's two statements — and not how many rows today
/// holds. A second snapshot on a day in which nothing moved answers `0`, which is the point: it
/// wrote nothing. The rows the day's first snapshot [`prune`]s are not in it. No caller reads it
/// but the tests; the launch, the ingest and the feed store only ask whether it failed.
///
/// **Its own transaction**, which is both the atomicity (a day is written whole or not at all) and
/// the cross-file fence the module doc describes — called inside a caller's transaction it
/// refuses rather than joining it.
pub fn snapshot(conn: &Connection) -> rusqlite::Result<usize> {
    write_snapshot(conn, &priced_markets())
}

/// [`snapshot`] for one marketplace — what a feed store calls, since a refresh moved only its own
/// prices and the other three would be rewritten with the numbers they already hold.
pub fn snapshot_market(conn: &Connection, market: Marketplace) -> rusqlite::Result<usize> {
    write_snapshot(conn, &[market])
}

fn write_snapshot(conn: &Connection, markets: &[Marketplace]) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    // The day, read once and bound into every statement below — the first-of-day probe, the
    // floor, and each marketplace's delete and insert — so a snapshot straddling UTC midnight
    // cannot delete one day's rows and write the next day's.
    let today: String = tx.query_row("SELECT date('now')", [], |r| r.get(0))?;
    // **Decided before anything is deleted, and the order is the rule**: the loop below can empty
    // today for a marketplace — every row, when it prices nothing held or the reader holds
    // nothing — so asked after it a snapshot could look like the day's first and thin again. One
    // seek on the primary key, which leads with `day`.
    let first_today: bool = tx.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM price_snapshots WHERE day = ?1)",
        params![today],
        |r| r.get(0),
    )?;
    if first_today {
        // The previous snapshot day, pushed back by the daily band: every row older than *that*
        // was already weighed by the thinning that ran in the previous day's snapshot, because a
        // committed snapshot is a committed thinning. `date(NULL, …)` is NULL, so a table with no
        // earlier day weighs everything — which on the first day ever is nothing.
        let floor: Option<String> = tx.query_row(
            "SELECT date(max(day), '-' || ?1 || ' days') FROM price_snapshots
              WHERE day < ?2",
            params![DAILY_DAYS, today],
            |r| r.get(0),
        )?;
        prune(&tx, floor.as_deref())?;
    }
    // The wishlist's table keeps its own calendar, by the same rule and for the same reason: a
    // reader who owns nothing and wishes for plenty has wish rows on days with no price row, and
    // a probe of the other table would call every one of their snapshots the day's first.
    let first_wish_day: bool = tx.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM wish_snapshots WHERE day = ?1)",
        params![today],
        |r| r.get(0),
    )?;
    if first_wish_day {
        let floor: Option<String> = tx.query_row(
            "SELECT date(max(day), '-' || ?1 || ' days') FROM wish_snapshots
              WHERE day < ?2",
            params![DAILY_DAYS, today],
            |r| r.get(0),
        )?;
        prune_wishes(&tx, floor.as_deref())?;
    }
    // The watch list, read once inside the transaction and bound as `?3` into both statements.
    // A list of strings always serialises; the fallback is the type system's, not a case.
    let watch = serde_json::to_string(&watched(&tx)).unwrap_or_else(|_| "[]".to_owned());
    let mut written = 0;
    for market in markets {
        let key = market_key(*market);
        // **Stale rows first, then the upsert, and only the difference is written.** The day
        // holds its LAST snapshot's holding and nothing older, so a row of this marketplace's day
        // that the new holding does not contain goes — a printing sold since the morning's
        // snapshot, or every row when the marketplace has stopped pricing anything held — where
        // an insert-or-replace would have left it standing and the value graph would count it held
        // that day. Every other row is left alone unless its price or its copies moved.
        //
        // This replaced a DELETE of the marketplace's whole day and a plain INSERT of it again,
        // which kept exactly the same rule and rewrote every row on every launch, ingest and feed
        // store — thousands of rows, both b-trees, a third of a megabyte of WAL on a USB stick
        // for a day in which nothing had changed.
        written += tx.execute(&stale_sql(&tx, *market), params![key, today, watch])?;
        written += tx.execute(&snapshot_sql(&tx, *market), params![key, today, watch])?;
        // And the wishlist's holding, by the same two statements' rules.
        written += tx.execute(&wish_stale_sql(*market), params![key, today])?;
        written += tx.execute(&wish_snapshot_sql(*market), params![key, today])?;
    }
    tx.commit()?;
    Ok(written)
}

/// The holding a snapshot records for one marketplace today, as the CTE both of
/// [`write_snapshot`]'s statements open with: `held(card_id, finish, price, copies)`, one row per
/// printing and finish the reader holds **or watches**.
///
/// **`WITH owned(card_id, finish, copies)`** is [`collection_source::copies_by_printing_and_finish`]
/// under [`Availability::Everything`], named — the crate's one statement of "which printings does
/// the reader own, per finish". **`wanted(card_id, finish)`** is every printing a wish pins and
/// every one on the watch list (bound as `?3`), in [`wished_printings`]' and [`listed_printings`]'
/// finishes. `held` groups the two on `(card_id, finish)`, so it never names one key twice — which
/// the upsert needs, since `DO UPDATE` may not touch one row twice — and a printing both owned and
/// watched is one row carrying its owned count.
///
/// **Every held printing is a row, priced or not** (user schema v50): `price` is NULL where this
/// marketplace does not quote that finish, and `cards` is a `LEFT JOIN`, so a printing the corpus
/// has lost is still a holding — the live point of [`crate::value_history`] counts it, and a
/// snapshot that did not would read its return to the corpus as a purchase. **A watched printing
/// is a row only when it is priced**, at `copies = 0`: it is no holding, so no reader needs its
/// gaps, and the watch list's every finish would otherwise write two NULLs for each card.
///
/// **`copies` rides beside the price**: the same sum `owned` already computes to decide what is
/// owned, every folder at once, so a day's row says what the reader's holding of that printing was
/// worth and not only what one copy cost. [`crate::value_history`] is the reader.
///
/// **An owned row is priced by [`sorting::held_price_expr`]**, the collection's own figure, so a
/// `nonfoil` copy of a foil-only printing (issue #983) is recorded at the price the collection
/// page shows for it and its graph does not read the fix as a price move. A **watched** row keeps
/// [`sorting::price_expr`]: the watch list's every finish includes a `nonfoil` the printing is
/// not sold in, and pricing it would write a second row of the foil's figure under that name.
fn held_cte(conn: &Connection, market: Marketplace) -> String {
    format!(
        "WITH owned(card_id, finish, copies) AS ({owned}),
         wanted(card_id, finish) AS ({wished} UNION {listed}),
         held AS (
             SELECT card_id, finish, price, copies
               FROM (SELECT k.card_id AS card_id, k.finish AS finish,
                            CASE WHEN max(k.copies) > 0 THEN {held} ELSE {price} END AS price,
                            max(k.copies) AS copies
                       FROM (SELECT card_id, finish, copies FROM owned WHERE copies > 0
                             UNION ALL
                             SELECT card_id, finish, 0 FROM wanted) k
                       LEFT JOIN cards c ON c.id = k.card_id
                      GROUP BY k.card_id, k.finish)
              WHERE copies > 0 OR price IS NOT NULL
         )",
        owned = collection_source::copies_by_printing_and_finish(conn, Availability::Everything),
        wished = wished_printings(""),
        listed = listed_printings("?3"),
        held = sorting::held_price_expr(market, "k.finish"),
        price = sorting::price_expr(market, "k.finish"),
    )
}

/// **The one gate**, as the SQL both statements test: does this marketplace price any of the
/// held printings today? A marketplace that prices none of them has no rows that day at all,
/// which the module doc argues — so the delete takes all of them and the insert writes none.
const PRICES_SOMETHING_HELD: &str = "EXISTS (SELECT 1 FROM held WHERE price IS NOT NULL)";

/// One marketplace's delete for today: every row of its day the new holding does not contain.
/// Bound: `?1` the marketplace key, `?2` today (`YYYY-MM-DD`), `?3` the watch list (JSON).
///
/// A row goes when its `(card_id, finish)` is no longer held — sold, or stepped to zero, since
/// the day's previous snapshot — or when [`PRICES_SOMETHING_HELD`] is false and the whole day
/// goes. What survives is exactly the set of keys [`snapshot_sql`] is about to write, so the
/// upsert that follows leaves the day holding this snapshot's rows and no older one.
fn stale_sql(conn: &Connection, market: Marketplace) -> String {
    format!(
        "{held}
         DELETE FROM price_snapshots
          WHERE day = ?2 AND marketplace = ?1
            AND (NOT {PRICES_SOMETHING_HELD}
                 OR NOT EXISTS (SELECT 1 FROM held h
                                 WHERE h.card_id = price_snapshots.card_id
                                   AND h.finish = price_snapshots.finish))",
        held = held_cte(conn, market),
    )
}

/// One marketplace's upsert for today, into a day [`stale_sql`] has just trimmed to the keys it
/// writes. Bound: `?1` the marketplace key, `?2` today (`YYYY-MM-DD`), `?3` the watch list (JSON).
///
/// **A row that already says the same thing is not written.** The `DO UPDATE` carries a `WHERE`
/// that compares both values with `IS NOT`, so a NULL price that stays NULL is no change and a
/// price that becomes NULL is one; a skipped row is not counted by `changes()` and dirties no page.
/// The target is the table's whole primary key, which a `WITHOUT ROWID` table's upsert must name.
///
/// **The gate's `WHERE` is load-bearing twice**: it is the rule, and it is what lets SQLite parse
/// this at all — in an `INSERT … SELECT … ON CONFLICT`, a `SELECT` with no `WHERE` of its own reads
/// the `ON` as a join constraint. Removing the gate needs a `WHERE true` in its place.
fn snapshot_sql(conn: &Connection, market: Marketplace) -> String {
    format!(
        "{held}
         INSERT INTO price_snapshots (day, marketplace, card_id, finish, price, copies)
         SELECT ?2, ?1, card_id, finish, price, copies
           FROM held
          WHERE {PRICES_SOMETHING_HELD}
         ON CONFLICT (day, marketplace, card_id, finish) DO UPDATE
            SET price = excluded.price, copies = excluded.copies
          WHERE price_snapshots.price IS NOT excluded.price
             OR price_snapshots.copies IS NOT excluded.copies",
        held = held_cte(conn, market),
    )
}

/// **The wishlist's gate**, [`PRICES_SOMETHING_HELD`] over the wishes: a marketplace that prices
/// none of them writes no wish row that day, for the reason that rule gives — the day it first
/// prices something would otherwise read as the whole wishlist's value arriving in a price move.
const PRICES_SOMETHING_WISHED: &str = "EXISTS (SELECT 1 FROM wished WHERE price IS NOT NULL)";

/// One marketplace's delete of today's `wish_snapshots` rows (user schema v66) the wishlist no
/// longer holds — [`stale_sql`] over the wishes. Bound: `?1` the marketplace key, `?2` today.
///
/// `wished` is [`crate::wishlist::holding_sql`], the Wishlist value widget's own arithmetic per
/// wish, so the day holds what the wishlist cost at its last snapshot and nothing older: a wish
/// bought or removed since the morning has no row.
fn wish_stale_sql(market: Marketplace) -> String {
    format!(
        "WITH wished AS ({holding})
         DELETE FROM wish_snapshots
          WHERE day = ?2 AND marketplace = ?1
            AND (NOT {PRICES_SOMETHING_WISHED}
                 OR NOT EXISTS (SELECT 1 FROM wished h
                                 WHERE h.wish = wish_snapshots.wish
                                   AND h.finish = wish_snapshots.finish))",
        holding = crate::wishlist::holding_sql(market),
    )
}

/// One marketplace's upsert of today's wish rows, into a day [`wish_stale_sql`] has just trimmed
/// — [`snapshot_sql`]'s rules: **a row that already says the same thing is not written**, and the
/// gate's `WHERE` is also what lets SQLite parse the `ON CONFLICT`. Every wish is a row, priced or
/// not, so a price that starts or stops being quoted on a wish the reader kept is a price move on
/// the graph and never a wish arriving or leaving.
fn wish_snapshot_sql(market: Marketplace) -> String {
    format!(
        "WITH wished AS ({holding})
         INSERT INTO wish_snapshots (day, marketplace, wish, finish, card_id, price, copies)
         SELECT ?2, ?1, wish, finish, card_id, price, copies
           FROM wished
          WHERE {PRICES_SOMETHING_WISHED}
         ON CONFLICT (day, marketplace, wish, finish) DO UPDATE
            SET card_id = excluded.card_id, price = excluded.price, copies = excluded.copies
          WHERE wish_snapshots.card_id IS NOT excluded.card_id
             OR wish_snapshots.price IS NOT excluded.price
             OR wish_snapshots.copies IS NOT excluded.copies",
        holding = crate::wishlist::holding_sql(market),
    )
}

/// [`prune`] for `wish_snapshots`: nothing older than [`KEEP_DAYS`], and older than
/// [`DAILY_DAYS`] (and no older than `floor`) the latest row per wish per seven-day bucket, by
/// [`week_bucket`]. **One survivor per bucket, not two**: the graph reads the bucket's newest row
/// priced or not, and no mover or price chart reads this table, so an older priced row is read
/// by nobody.
pub(crate) fn prune_wishes(conn: &Connection, floor: Option<&str>) -> rusqlite::Result<usize> {
    let old = conn.execute(
        "DELETE FROM wish_snapshots WHERE day < date('now', '-' || ?1 || ' days')",
        params![KEEP_DAYS],
    )?;
    let thinned = conn.execute(
        &format!(
            "DELETE FROM wish_snapshots
              WHERE day < date('now', '-' || ?1 || ' days')
                AND day >= coalesce(?2, '')
                AND EXISTS (
                    SELECT 1 FROM wish_snapshots later
                     WHERE later.marketplace = wish_snapshots.marketplace
                       AND later.wish = wish_snapshots.wish
                       AND later.finish = wish_snapshots.finish
                       AND later.day > wish_snapshots.day
                       AND {later} = {this})",
            later = week_bucket("later.day"),
            this = week_bucket("wish_snapshots.day"),
        ),
        params![DAILY_DAYS, floor],
    )?;
    Ok(old + thinned)
}

/// Keep the history inside its bounds: drop what is older than [`KEEP_DAYS`], and thin what is
/// older than [`DAILY_DAYS`] — and no older than `floor`, when one is given — to the latest row
/// per printing per seven-day bucket. Answers how many rows went.
///
/// The bucket is `CAST(julianday(day) AS INTEGER) / 7` — fixed seven-day windows that do not care
/// about weekdays or year boundaries, so a bucket never splits in two at New Year the way a
/// `strftime('%W')` week does.
///
/// **`floor` is what makes this affordable at launch, and it was measured into existence.** The
/// thinning weighs each candidate row with an index probe for a later bucket-mate, and over the
/// whole band that is roughly ten microseconds a row: 104 000 rows (a thousand printings, two
/// marketplaces, a year of thinned history) took **2.4 s with nothing to delete**, measured
/// 2026-09-15 on Node 24's bundled SQLite rather than this crate's build. A row only needs weighing
/// once — the day it first crosses the daily horizon, since the survivor of a bucket is its newest
/// row and a newer one can only arrive inside the daily band — so [`snapshot`] passes the previous
/// snapshot day minus the band, and a daily reader weighs one day's rows: ~2 000, tens of
/// milliseconds. `None` weighs the whole band, which is the first day ever (nothing to weigh) and
/// the tests — `pub(crate)` for [`crate::value_history`]'s, which prove that a thinned table
/// reads exactly as the un-thinned one did.
///
/// **Two survivors per bucket, not one, once a row can carry no price** (user schema v50). The
/// bucket's newest row is what [`crate::value_history`] reads, priced or not; its newest *priced*
/// row is what [`movers`] and [`history`] read, since they skip a NULL. Keeping only the first
/// would let a week that ended unquoted take the bucket's last price with it, and a mover's
/// baseline or a history point would move because a NULL arrived — so a priced row goes only
/// when a later *priced* row shares its bucket, and a NULL row whenever any later row does,
/// because a NULL that is not the newest is read by nobody. On a table with no NULL rows that is
/// exactly the rule before v50. It costs the probe a primary-key lookup per later row it weighs,
/// since the index carries the key and not the price.
pub(crate) fn prune(conn: &Connection, floor: Option<&str>) -> rusqlite::Result<usize> {
    let old = conn.execute(
        "DELETE FROM price_snapshots WHERE day < date('now', '-' || ?1 || ' days')",
        params![KEEP_DAYS],
    )?;
    let thinned = conn.execute(
        &format!(
            "DELETE FROM price_snapshots
              WHERE day < date('now', '-' || ?1 || ' days')
                AND day >= coalesce(?2, '')
                AND EXISTS (
                    SELECT 1 FROM price_snapshots later
                     WHERE later.marketplace = price_snapshots.marketplace
                       AND later.card_id = price_snapshots.card_id
                       AND later.finish = price_snapshots.finish
                       AND later.day > price_snapshots.day
                       AND {later} = {this}
                       AND (later.price IS NOT NULL OR price_snapshots.price IS NULL))",
            later = week_bucket("later.day"),
            this = week_bucket("price_snapshots.day"),
        ),
        params![DAILY_DAYS, floor],
    )?;
    Ok(old + thinned)
}

/// The seven-day bucket a `YYYY-MM-DD` day falls in, as SQL over `day` — [`prune`]'s thinning
/// key, and the one [`crate::value_history`] applies again at read time.
///
/// **One spelling for both**, because the read's whole promise is that an un-thinned table and a
/// thinned one draw the same line: a bucket boundary that moved by a day between the two would
/// split one of the prune's buckets in two at read time and invent a point.
pub(crate) fn week_bucket(day: &str) -> String {
    format!("CAST(julianday({day}) AS INTEGER) / 7")
}

/// One owned printing whose price moved.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceMover {
    pub card_id: String,
    pub name: String,
    pub set_code: String,
    /// `sets.name`, else the printing's own `cards.set_name`; `None` only when neither is there.
    pub set_name: Option<String>,
    /// `nonfoil`, `foil` or `etched` — the finish the copy is and the price is quoted at.
    pub finish: String,
    /// Today's live price at the asked marketplace.
    pub now: f64,
    /// The price in the baseline snapshot.
    pub then: f64,
    /// `now - then`. Never zero.
    pub delta: f64,
}

/// The movers, and what they were measured against.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceMovers {
    pub movers: Vec<PriceMover>,
    /// Unix seconds (UTC midnight) of the newest baseline day in use, or `None` when no owned
    /// printing has a snapshot old enough for the window — see the module doc for why this is
    /// taken before zero moves are dropped.
    pub since: Option<i64>,
    /// Distinct snapshot days this marketplace holds.
    pub days: i64,
}

/// What a Price movers widget is narrowed to (issue #906) — the printings it measures, in place
/// of every owned one. Each list may be empty; a scope whose three are all empty names nothing
/// and answers no movers.
///
/// * `collection_folders` — collection folder ids, **each one direct**: the page expands a chosen
///   folder into everything filed under it (`folderDescendants`), exactly as the wishlist savings
///   widget's `shelves` are expanded. `0` is the root, the copies filed in no folder. Every kind
///   counts — a deck's group and `Recently removed` included — because a filter is not a write.
/// * `wishlist_folders` — wishlist folder ids, direct, `0` the root; a deck's managed wishlist is
///   a folder like any other here. An any-printing wish names no printing and is skipped.
/// * `cards` — printing ids, owned or not, each in every finish it is priced in.
///
/// Absent on the wire — every build before this, and a widget left on *Everything you own* —
/// is [`movers`]' own question, every owned printing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PriceMoverScope {
    pub collection_folders: Vec<i64>,
    pub wishlist_folders: Vec<i64>,
    pub cards: Vec<String>,
}

impl PriceMoverScope {
    /// The `pool(card_id, finish)` CTE body this scope reads. Bound: `?2` the collection folder
    /// ids, `?3` the wishlist folder ids, `?4` the card ids — each a JSON array.
    ///
    /// **It names `collection_entries` in its own `FROM`**, one of the statements
    /// [`crate::collection_source`]'s module doc lists: it narrows the copies by where they are
    /// filed, which no builder there does. `quantity > 0` is the builders' own ownership rule.
    fn pool_sql() -> String {
        format!(
            "SELECT e.card_id, e.finish FROM collection_entries e
              WHERE e.quantity > 0
                AND coalesce(e.folder_id, 0) IN (SELECT value FROM json_each(?2))
             UNION
             {wished}
             UNION
             {listed}",
            wished = wished_printings(
                " AND coalesce(w.folder_id, 0) IN (SELECT value FROM json_each(?3))"
            ),
            listed = listed_printings("?4"),
        )
    }
}

/// Which snapshot a printing is measured against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Window {
    Week,
    Month,
    All,
}

impl Window {
    /// The wire word, or a week for anything else — a future window this build has never heard
    /// of must be an answer, not a refusal.
    fn parse(word: &str) -> Window {
        match word {
            "30d" => Window::Month,
            "all" => Window::All,
            _ => Window::Week,
        }
    }

    /// The baseline subquery's `WHERE` term and its order. Static text chosen by a `match`; no
    /// byte of the request reaches the SQL.
    fn baseline(self) -> (&'static str, &'static str) {
        match self {
            Window::Week => ("p.day <= date('now', '-7 days')", "DESC"),
            Window::Month => ("p.day <= date('now', '-30 days')", "DESC"),
            // Before today, so a printing snapshotted for the first time this morning is not its
            // own baseline and every one of them a zero move.
            Window::All => ("p.day < date('now')", "ASC"),
        }
    }
}

/// Which way a mover may have gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Both,
    Up,
    Down,
}

impl Direction {
    fn parse(word: &str) -> Direction {
        match word {
            "up" => Direction::Up,
            "down" => Direction::Down,
            _ => Direction::Both,
        }
    }

    fn admits(self, delta: f64) -> bool {
        match self {
            Direction::Both => delta != 0.0,
            Direction::Up => delta > 0.0,
            Direction::Down => delta < 0.0,
        }
    }
}

/// The movers at `market` over `window`, largest move first, at most `limit` (clamped to
/// `1..=`[`MAX_LIMIT`]) — over every owned printing. [`movers_in`] with no scope.
pub fn movers(
    conn: &Connection,
    window: &str,
    direction: &str,
    market: Marketplace,
    limit: i64,
) -> Result<PriceMovers, String> {
    movers_in(conn, window, direction, market, limit, None)
}

/// The movers at `market` over `window` among the printings `scope` names — every owned one when
/// it is `None` — largest move first, at most `limit` (clamped to `1..=`[`MAX_LIMIT`]).
///
/// One statement answers every priced printing in the pool with a baseline; the zero filter, the
/// direction, the order and the limit are applied here, because `since` has to be read over the
/// rows *before* those four narrow them. The row count is the pool, not the history.
///
/// Sorted by `|delta|` descending, then name, card id and finish, so two moves of one size come
/// back in the same order on every read.
pub fn movers_in(
    conn: &Connection,
    window: &str,
    direction: &str,
    market: Marketplace,
    limit: i64,
    scope: Option<&PriceMoverScope>,
) -> Result<PriceMovers, String> {
    let limit = limit.clamp(1, MAX_LIMIT) as usize;
    let direction = Direction::parse(direction);
    let (cutoff, order) = Window::parse(window).baseline();

    // **Two pools, one statement after them.** Unscoped is the owned printings, through
    // `collection_source` as before; scoped is the three lists the page sent.
    let pool = match scope {
        None => format!(
            "owned(card_id, finish, copies) AS ({owned}),
             pool(card_id, finish) AS (SELECT card_id, finish FROM owned WHERE copies > 0)",
            owned =
                collection_source::copies_by_printing_and_finish(conn, Availability::Everything),
        ),
        Some(_) => format!("pool(card_id, finish) AS ({})", PriceMoverScope::pool_sql()),
    };
    let sql = format!(
        "WITH {pool},
         live AS (
             SELECT t.card_id AS card_id, t.finish AS finish, c.name AS name,
                    c.set_code AS set_code, c.set_name AS set_name, {price} AS now
               FROM pool t
               JOIN cards c ON c.id = t.card_id
         ),
         based AS (
             SELECT l.*,
                    (SELECT p.day FROM price_snapshots p
                      WHERE p.marketplace = ?1 AND p.card_id = l.card_id
                        AND p.finish = l.finish AND {cutoff}
                        AND p.price IS NOT NULL
                      ORDER BY p.day {order} LIMIT 1) AS then_day
               FROM live l
              WHERE l.now IS NOT NULL
         )
         SELECT b.card_id, b.name, b.set_code, coalesce(s.name, b.set_name), b.finish,
                b.now, p.price, unixepoch(b.then_day)
           FROM based b
           JOIN price_snapshots p
             ON p.day = b.then_day AND p.marketplace = ?1
            AND p.card_id = b.card_id AND p.finish = b.finish
           LEFT JOIN sets s ON s.code = b.set_code",
        price = sorting::price_expr(market, "t.finish"),
    );
    let key = market_key(market);

    let read = |r: &rusqlite::Row<'_>| {
        let now: f64 = r.get(5)?;
        let then: f64 = r.get(6)?;
        Ok((
            PriceMover {
                card_id: r.get(0)?,
                name: r.get(1)?,
                set_code: r.get(2)?,
                set_name: r.get(3)?,
                finish: r.get(4)?,
                now,
                then,
                delta: now - then,
            },
            r.get::<_, i64>(7)?,
        ))
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match scope {
        None => stmt.query_map(params![key], read),
        Some(scope) => {
            // Lists of numbers and strings always serialise; the fallback is the type system's.
            let json = |v: serde_json::Result<String>| v.unwrap_or_else(|_| "[]".to_owned());
            stmt.query_map(
                params![
                    key,
                    json(serde_json::to_string(&scope.collection_folders)),
                    json(serde_json::to_string(&scope.wishlist_folders)),
                    json(serde_json::to_string(&scope.cards))
                ],
                read,
            )
        }
    }
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?;

    let since = rows.iter().map(|(_, day)| *day).max();
    let mut movers: Vec<PriceMover> = rows
        .into_iter()
        .map(|(mover, _)| mover)
        .filter(|m| direction.admits(m.delta))
        .collect();
    movers.sort_by(|a, b| {
        b.delta
            .abs()
            .total_cmp(&a.delta.abs())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.card_id.cmp(&b.card_id))
            .then_with(|| a.finish.cmp(&b.finish))
    });
    movers.truncate(limit);

    Ok(PriceMovers {
        movers,
        since,
        days: snapshot_days(conn, key).map_err(|e| e.to_string())?,
    })
}

/// Distinct snapshot days held for one marketplace — days holding a **priced** row, so a day of
/// nothing but NULL-price holdings counts no more than a day with no row did before v50.
///
/// **A skip-scan rather than `count(DISTINCT day) … WHERE marketplace = ?`**, which reads every
/// row that marketplace holds — hundreds of thousands on a large collection, on every draw of the
/// widget. The recursive walk takes the next distinct day off the primary key (one seek, since the
/// key leads with `day`) and asks whether that day has a row for this marketplace (a second seek
/// on the key's first two columns): two seeks per day held, and the days held are bounded by
/// [`prune`] to a few dozen weeks' worth.
fn snapshot_days(conn: &Connection, key: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "WITH RECURSIVE d(day) AS (
             SELECT (SELECT day FROM price_snapshots ORDER BY day LIMIT 1)
             UNION ALL
             SELECT (SELECT p.day FROM price_snapshots p WHERE p.day > d.day
                      ORDER BY p.day LIMIT 1)
               FROM d WHERE d.day IS NOT NULL
         )
         SELECT count(*) FROM d
          WHERE d.day IS NOT NULL
            AND EXISTS (SELECT 1 FROM price_snapshots p
                         WHERE p.day = d.day AND p.marketplace = ?1
                           AND p.price IS NOT NULL)",
        params![key],
        |r| r.get(0),
    )
}

/// One kept snapshot of one printing's price.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricePoint {
    /// Unix seconds of the snapshot's UTC midnight — `unixepoch(day)`.
    pub day: i64,
    pub price: f64,
}

/// One printing's remembered prices at one marketplace, with today's beside them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceHistory {
    /// Every kept priced snapshot for this printing, finish and marketplace **before today**,
    /// oldest first.
    pub points: Vec<PricePoint>,
    /// Today's live price at the asked marketplace — the number [`movers`] calls `now` — or
    /// `None` when that finish is unpriced there or the card is not in the corpus.
    pub now: Option<f64>,
    /// Unix seconds of today's UTC midnight — `unixepoch(date('now'))`, so the page never reads
    /// a clock of its own for "today".
    pub today: i64,
}

/// [`history`]'s points. Bound: marketplace key, card id, finish, and today's `YYYY-MM-DD`. A
/// NULL-price row is a day the printing was held and not quoted — no point, as no row was not.
const HISTORY_SQL: &str = "SELECT unixepoch(day), price FROM price_snapshots
     WHERE marketplace = ?1 AND card_id = ?2 AND finish = ?3 AND day < ?4
       AND price IS NOT NULL
     ORDER BY day";

/// One printing's history at `market`: every kept snapshot before today, oldest first, and the
/// live price beside it.
///
/// * **Today is `now`'s and never a point**, `Window::All`'s rule: today's snapshot is an earlier
///   reading of the same day's live price, and a chart holding both draws one day twice.
///   The day is read **once**, by the first statement, and bound into the second, so a read
///   straddling UTC midnight cannot answer a point that is not before its own `today`.
/// * **`now` is [`sorting::held_price_expr`] against the `cards` row, with the finish bound as
///   `?2`** rather than written into the SQL — a scalar subquery, so an id the corpus does not hold is a
///   NULL rather than no row. It is **not** gated on ownership: a price is a fact about the
///   printing, and a mover the reader has since sold may still be open on the page.
/// * **An unknown card id is not an error.** `now` is `None`, and the points are whatever history
///   the table holds for that id — `card_id` is a soft reference, so a printing gone from the
///   corpus keeps its snapshots until [`prune`] ages them out.
/// * **A finish outside [`crate::schema::FINISHES`] is refused** in `collection`'s sentence.
///
/// **A seek, not a scan**: `idx_price_snapshots_printing` is `(marketplace, card_id, finish, day)`,
/// so the three equalities and the day bound are one index range already in day order. The index
/// carries the key and not the price, so each point costs one primary-key probe — at most
/// [`DAILY_DAYS`] daily rows plus one a week back to [`KEEP_DAYS`], about ninety, because
/// [`prune`] bounds them. `a_history_read_seeks_the_printing_index` pins the plan.
pub fn history(
    conn: &Connection,
    card_id: &str,
    finish: &str,
    market: Marketplace,
) -> Result<PriceHistory, String> {
    let finish = crate::collection::valid_finish(finish)?;
    let (day, today, now): (String, i64, Option<f64>) = conn
        .query_row(
            &format!(
                "SELECT date('now'), unixepoch(date('now')),
                        (SELECT {price} FROM cards c WHERE c.id = ?1)",
                price = sorting::held_price_expr(market, "?2"),
            ),
            params![card_id, finish],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(HISTORY_SQL).map_err(|e| e.to_string())?;
    let points = stmt
        .query_map(params![market_key(market), card_id, finish, day], |r| {
            Ok(PricePoint {
                day: r.get(0)?,
                price: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(PriceHistory { points, now, today })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pair with three printings carrying TCGplayer and Cardmarket prices in their blobs, one
    /// with no price at all, and one Card Kingdom feed row. Nothing is owned yet.
    fn conn() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO sets (code, name) VALUES ('lea', 'Limited Edition Alpha');
               INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang,
                                  layout, prices, raw) VALUES
                 ('bolt', 'o1', 'Lightning Bolt', 'lea', 'Alpha', '161', 'en', 'normal',
                  '{"usd":"10.00","usd_foil":"50.00","eur":"8.00"}', '{}'),
                 ('ring', 'o2', 'Sol Ring', 'lea', 'Alpha', '270', 'en', 'normal',
                  '{"usd":"100.00","eur":"90.00"}', '{}'),
                 ('free', 'o3', 'Unpriced', 'lea', 'Alpha', '1', 'en', 'normal', '{}', '{}'),
                 ('lonely', 'o4', 'Not Owned', 'lea', 'Alpha', '2', 'en', 'normal',
                  '{"usd":"3.00"}', '{}');
               INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
                 VALUES ('cardkingdom', 'bolt', 'nonfoil', 12.5);"#,
        )
        .unwrap();
        conn
    }

    fn own(conn: &Connection, card_id: &str, finish: &str) {
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, created_at, updated_at)
             VALUES (?1, 'lea', '0', 'en', ?2, 'NM', 2, 0, 0)",
            params![card_id, finish],
        )
        .unwrap();
    }

    /// A snapshot row `ago` days back, written by hand — the only way a test can have history.
    fn past(conn: &Connection, ago: i64, market: &str, card_id: &str, finish: &str, price: f64) {
        conn.execute(
            "INSERT OR REPLACE INTO price_snapshots (day, marketplace, card_id, finish, price)
             VALUES (date('now', '-' || ?1 || ' days'), ?2, ?3, ?4, ?5)",
            params![ago, market, card_id, finish, price],
        )
        .unwrap();
    }

    /// A held printing's row with no price — what a snapshot writes, since user schema v50, for a
    /// finish the marketplace does not quote.
    fn unpriced(conn: &Connection, ago: i64, market: &str, card_id: &str, finish: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO price_snapshots (day, marketplace, card_id, finish, price,
                                                     copies)
             VALUES (date('now', '-' || ?1 || ' days'), ?2, ?3, ?4, NULL, 2)",
            params![ago, market, card_id, finish],
        )
        .unwrap();
    }

    fn rows(conn: &Connection) -> Vec<(String, String, String, Option<f64>)> {
        let mut stmt = conn
            .prepare(
                "SELECT marketplace, card_id, finish, price FROM price_snapshots
                  WHERE day = date('now') ORDER BY marketplace, card_id, finish",
            )
            .unwrap();
        let out = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM price_snapshots", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn every_marketplace_id_maps_to_one_priced_key() {
        let markets = priced_markets();
        assert_eq!(
            markets.len(),
            4,
            "cardtrader quotes TCGplayer and is not a fifth"
        );
        for id in crate::marketplace::MARKETPLACE_IDS {
            let key = market_key(Marketplace::from_id(id));
            assert!(crate::marketplace::MARKETPLACE_IDS.contains(&key), "{key}");
        }
        for market in markets {
            assert_eq!(
                Marketplace::from_id(market_key(market)),
                market,
                "a key round-trips"
            );
        }
    }

    /// **Every held printing is a row, and a finish the marketplace does not quote is a NULL
    /// price — never a zero, and since user schema v50 never a missing row.** The price is the
    /// copy's own finish, never a neighbour's; a printing the corpus has lost is still held; and
    /// a marketplace that prices none of the holding writes nothing at all.
    #[test]
    fn a_snapshot_writes_every_held_printing_and_an_unpriced_one_as_null() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        own(&conn, "bolt", "foil");
        own(&conn, "ring", "etched");
        own(&conn, "free", "nonfoil");
        own(&conn, "gone", "nonfoil");

        let written = snapshot(&conn).unwrap();

        let held = |m: &str, bolt: Option<f64>, bolt_foil: Option<f64>| {
            [
                ("bolt", "foil", bolt_foil),
                ("bolt", "nonfoil", bolt),
                ("free", "nonfoil", None),
                ("gone", "nonfoil", None),
                ("ring", "etched", None),
            ]
            .map(|(id, finish, price)| (m.to_owned(), id.to_owned(), finish.to_owned(), price))
        };
        // No `lonely` (not owned). `free` is unpriced everywhere and `gone` is not in the corpus,
        // so both are NULL wherever they are written; so is the etched `ring` (no `usd_etched`,
        // Cardmarket's etched hole, no feed row) and **the Cardmarket foil bolt**: the blob has no
        // `eur_foil`, and a foil copy is never quoted at the nonfoil rate. **No Mana Pool row at
        // all**: its feed quotes none of the five, and a marketplace that prices nothing held
        // writes nothing rather than five NULLs.
        let want = [
            held("cardkingdom", Some(12.5), None),
            held("cardmarket", Some(8.0), None),
            held("tcgplayer", Some(10.0), Some(50.0)),
        ]
        .concat();
        assert_eq!(rows(&conn), want);
        assert_eq!(written, want.len());
    }

    /// **The day holds its last snapshot's holding** (Finding B of the value graph's review): a
    /// printing sold between two snapshots on one afternoon has no row that day, and one bought
    /// up in between carries the later count. With an insert-or-replace the sold printing's
    /// morning row stood, and the graph counted it held on a day it had already gone.
    #[test]
    fn a_second_snapshot_the_same_day_keeps_only_the_last_holding() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        own(&conn, "ring", "nonfoil");
        snapshot(&conn).unwrap();

        conn.execute_batch(
            "DELETE FROM collection_entries WHERE card_id = 'ring';
             UPDATE collection_entries SET quantity = 5 WHERE card_id = 'bolt';",
        )
        .unwrap();
        snapshot(&conn).unwrap();

        let today = |sql: &str| -> i64 {
            conn.query_row(
                &format!("SELECT {sql} FROM price_snapshots WHERE day = date('now')"),
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            today("count(*) FILTER (WHERE card_id = 'ring')"),
            0,
            "the sold printing has no row on the day it went"
        );
        assert_eq!(today("min(copies)"), 5);
        assert_eq!(
            today("count(*)"),
            3,
            "bolt at the three marketplaces pricing it"
        );

        // **One marketplace's snapshot replaces that marketplace's day and no other's** — a feed
        // store rewrites its own prices, and the rest keep the reading their own last snapshot
        // took.
        own(&conn, "ring", "nonfoil");
        snapshot_market(&conn, Marketplace::Cardkingdom).unwrap();
        assert_eq!(today("count(*) FILTER (WHERE card_id = 'ring')"), 1);
        assert_eq!(
            today("count(*) FILTER (WHERE card_id = 'ring' AND marketplace = 'cardkingdom')"),
            1,
            "Card Kingdom quotes no ring, so its row is the holding without a price"
        );
    }

    /// **A snapshot that finds nothing moved writes nothing** — no row inserted, updated or
    /// deleted, which `total_changes` counts across both statements of every marketplace — and
    /// answers `0`. The day is what the first snapshot left, row for row.
    #[test]
    fn a_snapshot_that_changes_nothing_writes_nothing() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        own(&conn, "bolt", "foil");
        own(&conn, "free", "nonfoil"); // a NULL price that stays NULL is no change either
        own(&conn, "gone", "nonfoil");
        assert!(snapshot(&conn).unwrap() > 0);
        let before = rows(&conn);

        let changes = conn.total_changes();
        assert_eq!(snapshot(&conn).unwrap(), 0);
        assert_eq!(snapshot_market(&conn, Marketplace::Cardkingdom).unwrap(), 0);
        assert_eq!(
            conn.total_changes(),
            changes,
            "no row was touched, not even to write the value it already held"
        );
        assert_eq!(rows(&conn), before);
    }

    /// **Only what moved is written, and every kind of move is**: a price that changed, a price
    /// that stopped being quoted while the marketplace still prices something else held, copies
    /// that changed, and a printing no longer held — each counted once, and nothing else.
    #[test]
    fn a_snapshot_writes_only_the_rows_that_moved() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        own(&conn, "ring", "nonfoil");
        own(&conn, "free", "nonfoil");
        // TCGplayer, Cardmarket and Card Kingdom each hold the three; Mana Pool prices none.
        assert_eq!(snapshot(&conn).unwrap(), 9);

        conn.execute_batch(
            r#"UPDATE cards SET prices = '{"usd":"11.00","usd_foil":"50.00"}' WHERE id = 'bolt';
               UPDATE collection_entries SET quantity = 5 WHERE card_id = 'ring';
               DELETE FROM collection_entries WHERE card_id = 'free';"#,
        )
        .unwrap();
        let changes = conn.total_changes();
        let written = snapshot(&conn).unwrap();

        // bolt: TCGplayer 10 → 11, Cardmarket 8 → unquoted (it still prices the ring, so the
        // day stays); ring: copies 2 → 5 at all three; free: gone from all three.
        assert_eq!(written, 2 + 3 + 3);
        assert_eq!(
            (conn.total_changes() - changes) as usize,
            written,
            "the count is changes()"
        );
        assert_eq!(
            rows(&conn),
            [
                ("cardkingdom", "bolt", Some(12.5)),
                ("cardkingdom", "ring", None),
                ("cardmarket", "bolt", None),
                ("cardmarket", "ring", Some(90.0)),
                ("tcgplayer", "bolt", Some(11.0)),
                ("tcgplayer", "ring", Some(100.0)),
            ]
            .map(|(m, id, price)| (
                m.to_owned(),
                id.to_owned(),
                "nonfoil".to_owned(),
                price
            ))
        );
        let ring_copies: Vec<i64> = {
            let mut stmt = conn
                .prepare(
                    "SELECT copies FROM price_snapshots
                      WHERE day = date('now') AND card_id = 'ring' ORDER BY marketplace",
                )
                .unwrap();
            let out = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            out
        };
        assert_eq!(ring_copies, [5, 5, 5]);
    }

    /// **A marketplace that stops pricing anything held loses its whole day**, NULL rows
    /// included, because the day it prices nothing it would have written nothing — and the other
    /// marketplaces' rows are not touched by its snapshot.
    #[test]
    fn a_marketplace_that_stops_pricing_anything_held_loses_its_day() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        own(&conn, "ring", "nonfoil"); // a NULL row at Card Kingdom while the bolt is priced
        snapshot(&conn).unwrap();
        let others: Vec<_> = rows(&conn)
            .into_iter()
            .filter(|r| r.0 != "cardkingdom")
            .collect();

        conn.execute("DELETE FROM marketplace_prices", []).unwrap();
        assert_eq!(
            snapshot_market(&conn, Marketplace::Cardkingdom).unwrap(),
            2,
            "the priced bolt and the unpriced ring both go"
        );
        assert_eq!(rows(&conn), others);
    }

    /// **The day's first snapshot is decided before any snapshot deletes the day**, so a second
    /// one does not prune again — which it would if the probe ran after the delete had emptied
    /// the day. An ancient row planted between the two is the witness: only a prune removes it.
    #[test]
    fn a_second_snapshot_the_same_day_does_not_prune() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        snapshot(&conn).unwrap();
        past(&conn, KEEP_DAYS + 1, "tcgplayer", "bolt", "nonfoil", 1.0);

        snapshot(&conn).unwrap();

        let ancient: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE day < date('now', '-400 days')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ancient, 1, "the second snapshot of a day is not its first");
    }

    /// **A NULL-price row changes nothing for movers or history** — not a baseline, not a point,
    /// not a day held — before a prune and after one. Two tables are built from the same priced
    /// rows and one of them is also given the unpriced holdings a v50 snapshot writes, each placed
    /// where a reader that did not skip it would answer differently: newer than a window's
    /// baseline, older than `all`'s, a day holding nothing else, a printing never priced at all,
    /// and — the prune's half — a week that ends unquoted, whose last price the thinning must not
    /// give up to the NULL behind it.
    #[test]
    fn an_unpriced_row_changes_nothing_for_movers_or_history() {
        let week_end = |conn: &Connection| -> i64 {
            // A day whose next day shares its seven-day bucket, beyond the daily band.
            (55..=65)
                .find(|&ago| {
                    let bucket = |ago: i64| -> i64 {
                        conn.query_row(
                            &format!(
                                "SELECT {}",
                                week_bucket("date('now', '-' || ?1 || ' days')")
                            ),
                            [ago],
                            |r| r.get(0),
                        )
                        .unwrap()
                    };
                    bucket(ago) == bucket(ago - 1)
                })
                .unwrap()
        };
        let build = |with_nulls: bool| -> Connection {
            let conn = conn();
            own(&conn, "bolt", "nonfoil"); // live 10
            own(&conn, "bolt", "foil"); // live 50
            own(&conn, "ring", "nonfoil"); // live 100
            own(&conn, "free", "nonfoil"); // never priced
            let end = week_end(&conn);
            for (ago, price) in [(3, 9.0), (8, 7.0), (31, 4.0), (end, 2.0)] {
                past(&conn, ago, "tcgplayer", "bolt", "nonfoil", price);
            }
            past(&conn, 8, "tcgplayer", "bolt", "foil", 45.0);
            past(&conn, end, "tcgplayer", "ring", "nonfoil", 90.0);
            if with_nulls {
                unpriced(&conn, 7, "tcgplayer", "bolt", "nonfoil"); // newer than 7d's baseline
                unpriced(&conn, 30, "tcgplayer", "bolt", "nonfoil"); // newer than 30d's
                unpriced(&conn, end - 1, "tcgplayer", "bolt", "nonfoil"); // the week ends unquoted
                unpriced(&conn, end - 1, "tcgplayer", "ring", "nonfoil");
                unpriced(&conn, 80, "tcgplayer", "bolt", "nonfoil"); // older than `all`'s
                unpriced(&conn, 80, "tcgplayer", "bolt", "foil"); // and alone on its day
                for ago in [1, 8, 31, 80] {
                    unpriced(&conn, ago, "tcgplayer", "free", "nonfoil");
                }
            }
            conn
        };
        let answers = |conn: &Connection| {
            let mut out: Vec<String> = Vec::new();
            for window in ["7d", "30d", "all"] {
                for direction in ["both", "up", "down"] {
                    let m = movers(conn, window, direction, Marketplace::Tcgplayer, 10).unwrap();
                    out.push(format!("{window} {direction}: {m:?}"));
                }
            }
            for (id, finish) in [("bolt", "nonfoil"), ("bolt", "foil"), ("ring", "nonfoil")] {
                let h = history(conn, id, finish, Marketplace::Tcgplayer).unwrap();
                out.push(format!("{id} {finish}: {h:?}"));
            }
            let free = history(conn, "free", "nonfoil", Marketplace::Tcgplayer).unwrap();
            out.push(format!("free: {free:?}"));
            out
        };

        let plain = build(false);
        let mixed = build(true);
        assert_eq!(answers(&mixed), answers(&plain));

        prune(&plain, None).unwrap();
        prune(&mixed, None).unwrap();
        assert_eq!(answers(&mixed), answers(&plain), "and after a prune");

        // The prune kept the unquoted week's last price *and* its NULL: the one a mover and a
        // history point read, and the one the value graph reads.
        let kept: Vec<Option<f64>> = {
            let end = week_end(&mixed);
            let mut stmt = mixed
                .prepare(
                    "SELECT price FROM price_snapshots
                      WHERE card_id = 'bolt' AND finish = 'nonfoil'
                        AND day IN (date('now', '-' || ?1 || ' days'),
                                    date('now', '-' || ?2 || ' days'))
                      ORDER BY day",
                )
                .unwrap();
            let out = stmt
                .query_map(params![end, end - 1], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            out
        };
        assert_eq!(kept, [Some(2.0), None]);
    }

    #[test]
    fn a_snapshot_is_idempotent_per_day_and_keeps_the_latest_price() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        snapshot(&conn).unwrap();
        let first = count(&conn);

        conn.execute(
            r#"UPDATE cards SET prices = '{"usd":"11.00","eur":"8.00"}' WHERE id = 'bolt'"#,
            [],
        )
        .unwrap();
        snapshot(&conn).unwrap();

        assert_eq!(
            count(&conn),
            first,
            "a second snapshot today is the same rows"
        );
        let tcg: f64 = conn
            .query_row(
                "SELECT price FROM price_snapshots
                  WHERE day = date('now') AND marketplace = 'tcgplayer' AND card_id = 'bolt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tcg, 11.0, "and it carries the day's latest price");
    }

    #[test]
    fn a_market_snapshot_writes_only_that_marketplace() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        assert_eq!(snapshot_market(&conn, Marketplace::Cardkingdom).unwrap(), 1);
        let got = rows(&conn);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "cardkingdom");
    }

    /// **`copies` is the holding, every folder at once** (user schema v50): two copies at the
    /// root and one in a folder are one printing held three times, and the row says 3 — while a
    /// printing held at another finish is its own row with its own count.
    #[test]
    fn a_snapshot_records_the_copies_held_across_every_folder() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil"); // two, at the root
        own(&conn, "bolt", "foil"); // two foil, their own row
        conn.execute_batch(
            "INSERT INTO collection_folders (id, name, sort_order, created_at, updated_at)
                 VALUES (7, 'Binder', 0, 0, 0);
             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, folder_id, created_at,
                                             updated_at)
                 VALUES ('bolt', 'lea', '0', 'en', 'nonfoil', 'NM', 1, 7, 0, 0);",
        )
        .unwrap();

        snapshot(&conn).unwrap();

        let copies = |finish: &str| -> Option<i64> {
            conn.query_row(
                "SELECT copies FROM price_snapshots
                  WHERE day = date('now') AND marketplace = 'tcgplayer'
                    AND card_id = 'bolt' AND finish = ?1",
                [finish],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(copies("nonfoil"), Some(3), "two at the root and one filed");
        assert_eq!(copies("foil"), Some(2), "a finish is its own holding");
        let unrecorded: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE copies IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            unrecorded, 0,
            "every row a snapshot writes carries its count"
        );
    }

    /// The fence the module doc leans on: inside somebody else's transaction a snapshot refuses
    /// rather than joining it, so it can never be half of a cross-file commit.
    #[test]
    fn a_snapshot_refuses_to_run_inside_someone_elses_transaction() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        conn.execute_batch("BEGIN").unwrap();
        assert!(snapshot(&conn).is_err());
        conn.execute_batch("ROLLBACK").unwrap();
        assert!(snapshot(&conn).unwrap() > 0);
    }

    /// Past the keep horizon everything goes; inside the daily band nothing does; between them one
    /// row per printing per seven-day bucket survives, and it is the latest.
    #[test]
    fn prune_drops_the_old_and_thins_the_middle_to_one_row_a_week() {
        let conn = conn();
        past(&conn, KEEP_DAYS + 5, "tcgplayer", "bolt", "nonfoil", 1.0);
        for ago in 1..=DAILY_DAYS {
            past(&conn, ago, "tcgplayer", "bolt", "nonfoil", ago as f64);
        }
        // Seventy consecutive days beyond the daily band: ten buckets' worth.
        for ago in 100..170 {
            past(&conn, ago, "tcgplayer", "bolt", "nonfoil", ago as f64);
            past(&conn, ago, "cardmarket", "bolt", "nonfoil", ago as f64);
        }

        prune(&conn, None).unwrap();

        let older_than_keep: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE day < date('now', '-400 days')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(older_than_keep, 0);
        let daily: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE day >= date('now', '-35 days')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(daily, DAILY_DAYS, "the daily band is untouched");
        let per_bucket: Vec<(i64, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT CAST(julianday(day) AS INTEGER) / 7 AS b, count(*)
                       FROM price_snapshots
                      WHERE day < date('now', '-35 days') AND marketplace = 'tcgplayer'
                      GROUP BY b",
                )
                .unwrap();
            let out = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            out
        };
        assert!(
            per_bucket.len() >= 10,
            "seventy days span ten or more buckets"
        );
        assert!(per_bucket.iter().all(|(_, n)| *n == 1), "{per_bucket:?}");
        // The survivor of each bucket is its newest day: the day 100 back is the newest row of
        // its bucket, so it must still be there.
        let newest_kept: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots
                  WHERE marketplace = 'tcgplayer' AND day = date('now', '-100 days')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(newest_kept, 1);
        // And marketplaces are thinned independently.
        let cardmarket: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE marketplace = 'cardmarket'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cardmarket, per_bucket.len() as i64);

        // Twice is once.
        assert_eq!(prune(&conn, None).unwrap(), 0);
    }

    /// The day's first snapshot is what prunes; later ones that day do not re-scan.
    #[test]
    fn the_first_snapshot_of_a_day_prunes() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        past(&conn, KEEP_DAYS + 1, "tcgplayer", "bolt", "nonfoil", 1.0);
        snapshot(&conn).unwrap();
        let ancient: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE day < date('now', '-400 days')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ancient, 0);
    }

    /// The snapshot's thinning weighs only rows that crossed the daily horizon since the previous
    /// snapshot day. Rows further back were weighed by that day's own snapshot, so a week of
    /// unthinned rows planted there by hand — a state no run of the app produces — is left alone,
    /// while the full prune weighs them. That difference *is* the floor, and the tests above that
    /// call `prune(…, None)` are what prove the weighing itself.
    #[test]
    fn a_snapshot_thins_only_what_crossed_the_horizon_since_the_previous_day() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        past(&conn, 1, "tcgplayer", "bolt", "nonfoil", 9.0); // the previous snapshot day
        for ago in 100..107 {
            past(&conn, ago, "tcgplayer", "bolt", "nonfoil", 1.0);
        }
        let old_band = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM price_snapshots WHERE day < date('now', '-99 days')",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        snapshot(&conn).unwrap();
        assert_eq!(old_band(&conn), 7, "below the floor, so not weighed again");

        prune(&conn, None).unwrap();
        assert!(
            old_band(&conn) < 7,
            "a full prune does weigh them: seven days share a bucket"
        );
    }

    /// The live price against each window's baseline: 7d takes the newest row at least a week
    /// old, 30d the newest at least thirty days old, `all` the oldest before today.
    #[test]
    fn each_window_measures_against_its_own_baseline() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil"); // live 10.00 at TCGplayer
        past(&conn, 3, "tcgplayer", "bolt", "nonfoil", 9.0); // too young for 7d
        past(&conn, 8, "tcgplayer", "bolt", "nonfoil", 7.0); // 7d baseline
        past(&conn, 20, "tcgplayer", "bolt", "nonfoil", 6.0);
        past(&conn, 31, "tcgplayer", "bolt", "nonfoil", 4.0); // 30d baseline
        past(&conn, 60, "tcgplayer", "bolt", "nonfoil", 2.0); // oldest

        let then = |window: &str| {
            let out = movers(&conn, window, "both", Marketplace::Tcgplayer, 10).unwrap();
            assert_eq!(out.movers.len(), 1, "{window}");
            (out.movers[0].then, out.movers[0].delta, out.since)
        };
        let day = |ago: i64| -> i64 {
            conn.query_row(
                "SELECT unixepoch(date('now', '-' || ?1 || ' days'))",
                [ago],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(then("7d"), (7.0, 3.0, Some(day(8))));
        assert_eq!(then("30d"), (4.0, 6.0, Some(day(31))));
        assert_eq!(then("all"), (2.0, 8.0, Some(day(60))));
        assert_eq!(then("fortnight"), then("7d"), "an unknown window is a week");
    }

    /// No snapshot old enough is no movers and `since: null` — never a younger baseline — while
    /// a window where history exists and nothing moved answers `since` all the same.
    #[test]
    fn no_baseline_is_null_since_and_nothing_moving_is_not() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        past(&conn, 2, "tcgplayer", "bolt", "nonfoil", 9.0);
        let young = movers(&conn, "7d", "both", Marketplace::Tcgplayer, 10).unwrap();
        assert!(young.movers.is_empty());
        assert_eq!(
            young.since, None,
            "a two-day-old row is no baseline for a week"
        );
        assert_eq!(young.days, 1);

        past(&conn, 9, "tcgplayer", "bolt", "nonfoil", 10.0); // same as live
        let still = movers(&conn, "7d", "both", Marketplace::Tcgplayer, 10).unwrap();
        assert!(still.movers.is_empty(), "a zero move is not a mover");
        assert!(
            still.since.is_some(),
            "but there is history, and the widget must know it"
        );
        assert_eq!(still.days, 2);
    }

    #[test]
    fn direction_filters_by_sign_and_both_ranks_by_size() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil"); // live 10
        own(&conn, "ring", "nonfoil"); // live 100
        own(&conn, "bolt", "foil"); // live 50
        past(&conn, 8, "tcgplayer", "bolt", "nonfoil", 12.0); // -2
        past(&conn, 8, "tcgplayer", "ring", "nonfoil", 95.0); // +5
        past(&conn, 8, "tcgplayer", "bolt", "foil", 50.0); // 0

        let both = movers(&conn, "7d", "both", Marketplace::Tcgplayer, 10).unwrap();
        let deltas: Vec<f64> = both.movers.iter().map(|m| m.delta).collect();
        assert_eq!(deltas, [5.0, -2.0], "largest move first, the zero dropped");
        let up = movers(&conn, "7d", "up", Marketplace::Tcgplayer, 10).unwrap();
        assert_eq!(up.movers.len(), 1);
        assert_eq!(up.movers[0].card_id, "ring");
        let down = movers(&conn, "7d", "down", Marketplace::Tcgplayer, 10).unwrap();
        assert_eq!(down.movers.len(), 1);
        assert_eq!(down.movers[0].card_id, "bolt");
        assert_eq!(
            down.movers[0].set_name.as_deref(),
            Some("Limited Edition Alpha")
        );
        assert_eq!(
            movers(&conn, "7d", "sideways", Marketplace::Tcgplayer, 10)
                .unwrap()
                .movers,
            both.movers,
            "an unknown direction is both"
        );
    }

    #[test]
    fn the_limit_is_clamped_to_one_through_a_hundred() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        own(&conn, "ring", "nonfoil");
        past(&conn, 8, "tcgplayer", "bolt", "nonfoil", 1.0);
        past(&conn, 8, "tcgplayer", "ring", "nonfoil", 1.0);
        let n = |limit: i64| {
            movers(&conn, "7d", "both", Marketplace::Tcgplayer, limit)
                .unwrap()
                .movers
                .len()
        };
        assert_eq!(n(0), 1, "0 means one, never all");
        assert_eq!(n(-5), 1);
        assert_eq!(n(1), 1);
        assert_eq!(n(1_000), 2);
    }

    /// A baseline at one marketplace is no baseline at another, and `days` is per marketplace.
    #[test]
    fn marketplaces_do_not_share_a_history() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        past(&conn, 8, "cardmarket", "bolt", "nonfoil", 5.0);
        past(&conn, 9, "cardmarket", "bolt", "nonfoil", 5.0);

        let tcg = movers(&conn, "7d", "both", Marketplace::Tcgplayer, 10).unwrap();
        assert!(tcg.movers.is_empty());
        assert_eq!(tcg.since, None);
        assert_eq!(tcg.days, 0);

        let cm = movers(&conn, "7d", "both", Marketplace::Cardmarket, 10).unwrap();
        assert_eq!(cm.movers.len(), 1);
        assert_eq!((cm.movers[0].now, cm.movers[0].then), (8.0, 5.0));
        assert_eq!(cm.days, 2);

        // A feed-backed marketplace reads its own table, through the same builder.
        past(&conn, 8, "cardkingdom", "bolt", "nonfoil", 10.0);
        let ck = movers(&conn, "7d", "both", Marketplace::Cardkingdom, 10).unwrap();
        assert_eq!(ck.movers[0].delta, 2.5);
    }

    /// A printing the reader no longer owns is not a mover, whatever its history says.
    #[test]
    fn only_owned_printings_move() {
        let conn = conn();
        past(&conn, 8, "tcgplayer", "lonely", "nonfoil", 1.0);
        let out = movers(&conn, "7d", "both", Marketplace::Tcgplayer, 10).unwrap();
        assert!(out.movers.is_empty());
        assert_eq!(out.since, None);
        assert_eq!(
            out.days, 1,
            "the history is still there; it just moves nothing owned"
        );
    }

    /// A wish for one printing, filed at `folder` (`None` the root). `card_id: None` is an
    /// any-printing wish, `finish: None` a wish with no preferred finish.
    fn wish(conn: &Connection, card_id: Option<&str>, finish: Option<&str>, folder: Option<i64>) {
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id, card_id, name, quantity, preferred_finish,
                                           folder_id, created_at, updated_at)
             VALUES ('o-wish', ?1, 'A Wish', 1, ?2, ?3, 0, 0)",
            params![card_id, finish, folder],
        )
        .unwrap();
    }

    /// Today's rows with their copies, for the watched-printing tests.
    fn held_today(conn: &Connection) -> Vec<(String, String, String, Option<f64>, i64)> {
        let mut stmt = conn
            .prepare(
                "SELECT marketplace, card_id, finish, price, copies FROM price_snapshots
                  WHERE day = date('now') ORDER BY marketplace, card_id, finish",
            )
            .unwrap();
        let out = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    /// **The watch list keeps each id once, in the order given, and refuses rather than cuts.**
    /// Junk in the row reads as nothing, and a list that has not changed is not written again.
    #[test]
    fn the_watch_list_is_kept_tidy_and_bounded() {
        let conn = conn();
        assert!(watched(&conn).is_empty(), "no row is no watch");

        set_watched(&conn, &ids(&["ring", " ", "bolt", "ring", " lonely "])).unwrap();
        assert_eq!(watched(&conn), ids(&["ring", "bolt", "lonely"]));

        // An unchanged list writes nothing: stored in a spelling a rewrite would reformat, the
        // same list sent again leaves the row's text as it was.
        crate::app_meta::set_app_meta(&conn, K_PRICE_WATCH, r#"[ "ring","bolt","lonely" ]"#)
            .unwrap();
        set_watched(&conn, &ids(&["ring", "bolt", "lonely"])).unwrap();
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_PRICE_WATCH).as_deref(),
            Some(r#"[ "ring","bolt","lonely" ]"#),
            "the same list is not written again"
        );

        let many: Vec<String> = (0..=MAX_WATCHED).map(|n| format!("c{n}")).collect();
        assert_eq!(set_watched(&conn, &many).unwrap_err(), TOO_MANY_WATCHED);
        assert_eq!(watched(&conn).len(), 3, "a refused list leaves the old one");

        for junk in ["not json", "{}", r#"[1, null, "bolt", ""]"#] {
            crate::app_meta::set_app_meta(&conn, K_PRICE_WATCH, junk).unwrap();
            let want: Vec<String> = if junk.contains("bolt") {
                ids(&["bolt"])
            } else {
                Vec::new()
            };
            assert_eq!(watched(&conn), want, "{junk}");
        }
    }

    /// **A snapshot remembers the printings a wish pins and the watch list names, at no copies,
    /// and only where they are priced** (issue #906) — so a widget narrowed to a wishlist folder
    /// or an unowned card has history to measure. A printing both owned and watched is one row
    /// at its owned count, and an any-printing wish names no printing.
    #[test]
    fn a_snapshot_remembers_wished_and_watched_printings_at_no_copies() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil");
        wish(&conn, Some("lonely"), None, None); // every finish; only nonfoil is priced
        wish(&conn, Some("bolt"), Some("foil"), None); // a finish the reader does not hold
        wish(&conn, None, None, None); // any printing: nothing to remember
        set_watched(&conn, &ids(&["ring", "bolt", "nowhere"])).unwrap();

        snapshot(&conn).unwrap();

        let tcg: Vec<_> = held_today(&conn)
            .into_iter()
            .filter(|row| row.0 == "tcgplayer")
            .map(|(_, id, finish, price, copies)| (id, finish, price, copies))
            .collect();
        let row = |id: &str, finish: &str, price: f64, copies: i64| {
            (id.to_owned(), finish.to_owned(), Some(price), copies)
        };
        assert_eq!(
            tcg,
            [
                row("bolt", "foil", 50.0, 0),
                row("bolt", "nonfoil", 10.0, 2),
                row("lonely", "nonfoil", 3.0, 0),
                row("ring", "nonfoil", 100.0, 0),
            ],
            "no NULL rows for what is only watched, and `nowhere` is not in the corpus"
        );

        // The value graph never reads a watched row as a holding.
        let held: i64 = conn
            .query_row(
                "SELECT count(*) FROM price_snapshots WHERE day = date('now') AND copies > 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            held, 3,
            "bolt nonfoil at TCGplayer, Cardmarket and Card Kingdom"
        );

        // Stopping the watch takes the row out of the day, as selling a printing does.
        set_watched(&conn, &[]).unwrap();
        snapshot(&conn).unwrap();
        assert!(
            !held_today(&conn).iter().any(|row| row.1 == "ring"),
            "the day holds its last snapshot's printings"
        );
    }

    /// **A card chosen now is remembered now** (issue #1080): `set_price_watch` snapshots on a
    /// list that changed, so the card's history starts the day it is chosen and not at the next
    /// launch, ingest or feed refresh. An unchanged list snapshots nothing.
    #[test]
    fn watching_a_card_records_its_price_today() {
        let conn = conn();
        let ring_today = |conn: &Connection| {
            held_today(conn)
                .iter()
                .filter(|row| row.1 == "ring")
                .count()
        };
        assert_eq!(ring_today(&conn), 0);

        watch(&conn, &ids(&["ring"])).unwrap();
        assert_eq!(watched(&conn), ids(&["ring"]));
        assert!(
            ring_today(&conn) > 0,
            "the watched card is in today's snapshot"
        );

        // The same list again is no write and no snapshot: a row deleted behind its back stays gone.
        conn.execute("DELETE FROM price_snapshots WHERE card_id = 'ring'", [])
            .unwrap();
        watch(&conn, &ids(&["ring"])).unwrap();
        assert_eq!(ring_today(&conn), 0, "an unchanged list snapshots nothing");

        // Letting go of it takes it out of today, as the next snapshot would have.
        watch(&conn, &ids(&["ring", "bolt"])).unwrap();
        assert!(ring_today(&conn) > 0);
        watch(&conn, &[]).unwrap();
        assert_eq!(ring_today(&conn), 0);
    }

    /// **A scope measures what it names and nothing else**: a collection folder (the root is
    /// `0`), a wishlist folder, and a card the reader does not own — each against the history
    /// the snapshots kept for it.
    #[test]
    fn a_scope_narrows_movers_to_its_folders_and_cards() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO collection_folders (id, name, sort_order, created_at, updated_at)
                 VALUES (7, 'Binder', 0, 0, 0);
             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, folder_id, created_at,
                                             updated_at)
                 VALUES ('ring', 'lea', '0', 'en', 'nonfoil', 'NM', 1, 7, 0, 0);
             INSERT INTO wishlist_folders (id, name, sort_order, created_at, updated_at)
                 VALUES (3, 'Wants', 0, 0, 0);",
        )
        .unwrap();
        own(&conn, "bolt", "nonfoil"); // at the root, live 10
        wish(&conn, Some("bolt"), Some("foil"), Some(3)); // live 50
        past(&conn, 8, "tcgplayer", "bolt", "nonfoil", 9.0); // +1
        past(&conn, 8, "tcgplayer", "ring", "nonfoil", 90.0); // +10
        past(&conn, 8, "tcgplayer", "bolt", "foil", 40.0); // +10
        past(&conn, 8, "tcgplayer", "lonely", "nonfoil", 1.0); // +2, never owned

        let moved = |scope: PriceMoverScope| -> Vec<(String, String)> {
            movers_in(
                &conn,
                "7d",
                "both",
                Marketplace::Tcgplayer,
                10,
                Some(&scope),
            )
            .unwrap()
            .movers
            .into_iter()
            .map(|m| (m.card_id, m.finish))
            .collect()
        };
        let pair = |id: &str, finish: &str| (id.to_owned(), finish.to_owned());

        let everything = movers(&conn, "7d", "both", Marketplace::Tcgplayer, 10).unwrap();
        assert_eq!(
            everything.movers.len(),
            2,
            "unscoped is every owned printing"
        );

        assert_eq!(
            moved(PriceMoverScope {
                collection_folders: vec![7],
                ..Default::default()
            }),
            [pair("ring", "nonfoil")]
        );
        assert_eq!(
            moved(PriceMoverScope {
                collection_folders: vec![0],
                ..Default::default()
            }),
            [pair("bolt", "nonfoil")],
            "0 is the copies filed in no folder"
        );
        assert_eq!(
            moved(PriceMoverScope {
                wishlist_folders: vec![3],
                ..Default::default()
            }),
            [pair("bolt", "foil")]
        );
        assert_eq!(
            moved(PriceMoverScope {
                wishlist_folders: vec![0],
                ..Default::default()
            }),
            Vec::<(String, String)>::new(),
            "nothing is wished for at the root"
        );
        assert_eq!(
            moved(PriceMoverScope {
                cards: ids(&["lonely"]),
                ..Default::default()
            }),
            [pair("lonely", "nonfoil")],
            "a card the reader does not own moves against its own history"
        );
        assert_eq!(
            moved(PriceMoverScope {
                collection_folders: vec![7, 0],
                wishlist_folders: vec![3],
                cards: ids(&["bolt", "lonely"]),
            }),
            [
                pair("bolt", "foil"),
                pair("ring", "nonfoil"),
                pair("lonely", "nonfoil"),
                pair("bolt", "nonfoil"),
            ],
            "the three lists together, each printing once, largest move first"
        );

        let none = movers_in(
            &conn,
            "7d",
            "both",
            Marketplace::Tcgplayer,
            10,
            Some(&PriceMoverScope::default()),
        )
        .unwrap();
        assert!(none.movers.is_empty(), "an empty scope names nothing");
        assert_eq!(none.since, None);
        assert_eq!(none.days, 1, "the history is still there");
    }

    /// The wire's spelling: camelCase, and every list optional.
    #[test]
    fn a_scope_reads_the_names_the_page_sends() {
        let scope: PriceMoverScope = serde_json::from_value(serde_json::json!({
            "collectionFolders": [0, 7],
            "cards": ["bolt"],
        }))
        .unwrap();
        assert_eq!(
            scope,
            PriceMoverScope {
                collection_folders: vec![0, 7],
                wishlist_folders: Vec::new(),
                cards: ids(&["bolt"]),
            }
        );
    }

    /// `unixepoch` of the day `ago` days back, SQLite's own clock — what a point's `day` holds.
    fn day(conn: &Connection, ago: i64) -> i64 {
        conn.query_row(
            "SELECT unixepoch(date('now', '-' || ?1 || ' days'))",
            [ago],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn points(h: &PriceHistory) -> Vec<(i64, f64)> {
        h.points.iter().map(|p| (p.day, p.price)).collect()
    }

    /// Oldest first, today's own row left to `now`, and `today` SQLite's midnight rather than
    /// anybody's clock.
    #[test]
    fn a_history_is_every_day_before_today_oldest_first() {
        let conn = conn();
        past(&conn, 8, "tcgplayer", "bolt", "nonfoil", 7.0);
        past(&conn, 1, "tcgplayer", "bolt", "nonfoil", 9.0);
        past(&conn, 30, "tcgplayer", "bolt", "nonfoil", 4.0);
        past(&conn, 0, "tcgplayer", "bolt", "nonfoil", 9.5); // today: `now`'s, not a point

        let h = history(&conn, "bolt", "nonfoil", Marketplace::Tcgplayer).unwrap();

        assert_eq!(
            points(&h),
            [
                (day(&conn, 30), 4.0),
                (day(&conn, 8), 7.0),
                (day(&conn, 1), 9.0)
            ]
        );
        assert_eq!(h.now, Some(10.0), "the live blob price, not today's row");
        assert_eq!(h.today, day(&conn, 0));
    }

    /// Another marketplace's rows and another finish's rows are someone else's history.
    #[test]
    fn a_history_is_one_marketplace_and_one_finish() {
        let conn = conn();
        past(&conn, 8, "tcgplayer", "bolt", "nonfoil", 7.0);
        past(&conn, 8, "tcgplayer", "bolt", "foil", 45.0);
        past(&conn, 8, "cardmarket", "bolt", "nonfoil", 6.0);
        past(&conn, 8, "tcgplayer", "ring", "nonfoil", 90.0);

        let tcg = history(&conn, "bolt", "nonfoil", Marketplace::Tcgplayer).unwrap();
        assert_eq!(points(&tcg), [(day(&conn, 8), 7.0)]);
        let foil = history(&conn, "bolt", "foil", Marketplace::Tcgplayer).unwrap();
        assert_eq!(points(&foil), [(day(&conn, 8), 45.0)]);
        assert_eq!(foil.now, Some(50.0), "priced at its own finish");
        let cm = history(&conn, "bolt", "nonfoil", Marketplace::Cardmarket).unwrap();
        assert_eq!(points(&cm), [(day(&conn, 8), 6.0)]);
        assert_eq!(cm.now, Some(8.0));
        let mp = history(&conn, "bolt", "nonfoil", Marketplace::Manapool).unwrap();
        assert!(mp.points.is_empty());
        assert_eq!(mp.now, None, "no feed row is no price, never a neighbour's");
    }

    /// `now` goes through the one price builder, so a feed-backed marketplace reads its own
    /// table, the etched hole in Cardmarket is a hole here too, and ownership is not asked.
    #[test]
    fn now_is_the_live_price_at_the_asked_marketplace() {
        let conn = conn();
        let now = |id: &str, finish: &str, market: Marketplace| {
            history(&conn, id, finish, market).unwrap().now
        };
        assert_eq!(now("bolt", "nonfoil", Marketplace::Cardkingdom), Some(12.5));
        assert_eq!(now("bolt", "foil", Marketplace::Cardkingdom), None);
        assert_eq!(
            now("bolt", "foil", Marketplace::Cardmarket),
            None,
            "no eur_foil"
        );
        assert_eq!(
            now("ring", "etched", Marketplace::Tcgplayer),
            None,
            "no usd_etched"
        );
        assert_eq!(now("ring", "etched", Marketplace::Cardmarket), None);
        assert_eq!(now("free", "nonfoil", Marketplace::Tcgplayer), None);
        assert_eq!(
            now("lonely", "nonfoil", Marketplace::Tcgplayer),
            Some(3.0),
            "a price is a fact about the printing, owned or not"
        );
    }

    /// An id the corpus does not hold is no price and no refusal — and its history, if the table
    /// kept one, is still answered, because `card_id` is a soft reference.
    #[test]
    fn an_unknown_card_is_no_price_and_no_error() {
        let conn = conn();
        let none = history(&conn, "nowhere", "nonfoil", Marketplace::Tcgplayer).unwrap();
        assert!(none.points.is_empty());
        assert_eq!(none.now, None);
        assert_eq!(none.today, day(&conn, 0));

        past(&conn, 3, "tcgplayer", "gone", "foil", 2.0);
        let gone = history(&conn, "gone", "foil", Marketplace::Tcgplayer).unwrap();
        assert_eq!(points(&gone), [(day(&conn, 3), 2.0)]);
        assert_eq!(gone.now, None);
    }

    #[test]
    fn a_finish_outside_the_three_is_refused_in_the_collections_words() {
        let conn = conn();
        let err = history(&conn, "bolt", "gilded", Marketplace::Tcgplayer).unwrap_err();
        assert_eq!(
            err,
            crate::collection::valid_finish("gilded").unwrap_err(),
            "one sentence for one refusal"
        );
        assert!(history(&conn, "bolt", "", Marketplace::Tcgplayer).is_err());
        assert!(history(&conn, "bolt", "Foil", Marketplace::Tcgplayer).is_err());
    }

    /// The seek [`history`]'s doc promises: a range on the printing index, already in day order.
    #[test]
    fn a_history_read_seeks_the_printing_index() {
        let conn = conn();
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {HISTORY_SQL}"))
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map(params!["tcgplayer", "bolt", "nonfoil", "2026-09-24"], |r| {
                r.get(3)
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter()
                .any(|d| d.contains("idx_price_snapshots_printing")),
            "{plan:?}"
        );
        assert!(
            !plan.iter().any(|d| d.contains("TEMP B-TREE")),
            "no sort of its own: {plan:?}"
        );
    }

    #[test]
    fn the_history_serialises_under_the_names_the_page_reads() {
        let v = serde_json::to_value(PriceHistory {
            points: vec![PricePoint {
                day: 1_800_000_000,
                price: 1.5,
            }],
            now: None,
            today: 1_800_086_400,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "points": [{ "day": 1_800_000_000, "price": 1.5 }],
                "now": null,
                "today": 1_800_086_400
            })
        );
    }

    #[test]
    fn the_dtos_serialise_under_the_names_the_page_reads() {
        let v = serde_json::to_value(PriceMovers {
            movers: vec![PriceMover {
                card_id: "bolt".into(),
                name: "Lightning Bolt".into(),
                set_code: "lea".into(),
                set_name: None,
                finish: "foil".into(),
                now: 2.0,
                then: 1.5,
                delta: 0.5,
            }],
            since: Some(1_800_000_000),
            days: 3,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "movers": [{
                    "cardId": "bolt", "name": "Lightning Bolt", "setCode": "lea", "setName": null,
                    "finish": "foil", "now": 2.0, "then": 1.5, "delta": 0.5
                }],
                "since": 1_800_000_000,
                "days": 3
            })
        );
    }
}
