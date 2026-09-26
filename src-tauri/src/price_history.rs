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
//!   finish. So a snapshot is exactly the number the collection page showed that day, the etched
//!   hole in Cardmarket and a feed that does not quote a printing included — and an unpriced
//!   finish is a **NULL**, never a zero.
//! * **A row is a holding, not a price (user schema v50).** Every printing the reader holds gets
//!   its row, priced or not, so a card whose price starts or stops being quoted stays in the
//!   table and [`crate::value_history`] reads that as a price moving rather than as a card
//!   arriving or leaving. **Every reader in this module skips a NULL-price row exactly as it
//!   skipped an absent one** — never a mover, a baseline, a history point or a day held — and the
//!   thinning never lets one displace a priced row a reader here would have kept (see [`prune`]).
//!   **One exception, per marketplace per day: a marketplace that prices none of the held
//!   printings writes nothing.** That is a feed the reader never selected, and its rows would say
//!   nothing while doubling the table — and, worse, would make the day the feed first arrives read
//!   as the whole collection's value appearing in one price move. A missing day is a gap in that
//!   marketplace's line and never a step, because a period is only ever made from rows.
//! * **The day comes from SQLite's `date('now')`, UTC**, never `SystemTime::now()`, which panics on
//!   the web target — read **once** per snapshot and bound into every statement it makes. A
//!   calendar day is the key, and **a snapshot replaces its marketplace's whole day** — deleted,
//!   then written — so the day holds its last snapshot's prices and holding and nothing older: a
//!   printing sold between a sync and a feed refresh on one afternoon has no row that day, where an
//!   insert-or-replace would have left the morning's.
//! * **A marketplace is the *priced* one**: [`crate::marketplace::MARKETPLACE_IDS`] mapped through
//!   [`Marketplace::from_id`], so `cardtrader` — which quotes TCGplayer — is not a key of its own
//!   and cannot store a second copy of every TCGplayer row. [`market_key`] is the spelling.
//! * **It is best-effort, everywhere it is called.** A missed day is a gap in a widget; nothing
//!   that calls [`snapshot`] may fail because of it, and each caller logs or records the error and
//!   carries on. Three callers: the launch (`maintenance::snapshot_prices`), a card ingest
//!   (`sync.rs`, beside `last_ingest_at`) and a feed store (`marketplace_feed::store`, for that one
//!   marketplace). The browser build gets the launch and the feed store — both go through
//!   every-target code — and its card ingest's day is recorded by the next launch.
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
//! A mover is an owned, priced printing whose live price differs from its baseline: the latest
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
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

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

/// Record today's price for every owned printing in every priced marketplace, then keep the
/// history inside its bounds. Answers how many rows were written.
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
    // **Decided before anything is deleted, and the order is the rule**: the loop below empties
    // today for each marketplace it writes, so asked after it every snapshot would look like the
    // day's first and thin again. One seek on the primary key, which leads with `day`.
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
    let mut written = 0;
    for market in markets {
        let key = market_key(*market);
        // The day's rows for this marketplace go before its new ones arrive, so the day holds its
        // LAST snapshot's holding and nothing older. An insert-or-replace would leave the row of a
        // printing sold since the morning's snapshot standing, and the value graph would count it
        // held that day. The insert below is a plain `INSERT` for the same reason: without this
        // line a second snapshot today is a primary-key failure rather than a stale row.
        tx.execute(
            "DELETE FROM price_snapshots WHERE day = ?1 AND marketplace = ?2",
            params![today, key],
        )?;
        written += tx.execute(&snapshot_sql(&tx, *market), params![key, today])?;
    }
    tx.commit()?;
    Ok(written)
}

/// One marketplace's insert for today, into a day [`write_snapshot`] has just emptied for it.
/// Bound: `?1` the marketplace key, `?2` today (`YYYY-MM-DD`).
///
/// **`WITH owned(card_id, finish, copies)`** is [`collection_source::copies_by_printing_and_finish`]
/// under [`Availability::Everything`], named — the crate's one statement of "which printings does
/// the reader own, per finish". `held` writes the price expression once for the two places that
/// read it, the rows and the gate.
///
/// **Every held printing is a row, priced or not** (user schema v50): `price` is NULL where this
/// marketplace does not quote that finish, and `cards` is a `LEFT JOIN`, so a printing the corpus
/// has lost is still a holding — the live point of [`crate::value_history`] counts it, and a
/// snapshot that did not would read its return to the corpus as a purchase. **The one gate is
/// the `EXISTS`**: a marketplace that prices none of the held printings today writes nothing at
/// all, which the module doc argues.
///
/// **`copies` rides beside the price**: the same sum `owned` already computes to decide what is
/// owned, every folder at once, so a day's row says what the reader's holding of that printing was
/// worth and not only what one copy cost. [`crate::value_history`] is the reader.
fn snapshot_sql(conn: &Connection, market: Marketplace) -> String {
    format!(
        "WITH owned(card_id, finish, copies) AS ({owned}),
         held AS (
             SELECT o.card_id AS card_id, o.finish AS finish, {price} AS price,
                    o.copies AS copies
               FROM owned o
               LEFT JOIN cards c ON c.id = o.card_id
              WHERE o.copies > 0
         )
         INSERT INTO price_snapshots (day, marketplace, card_id, finish, price, copies)
         SELECT ?2, ?1, card_id, finish, price, copies
           FROM held
          WHERE EXISTS (SELECT 1 FROM held WHERE price IS NOT NULL)",
        owned = collection_source::copies_by_printing_and_finish(conn, Availability::Everything),
        price = sorting::price_expr(market, "o.finish"),
    )
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
/// `1..=`[`MAX_LIMIT`]).
///
/// One statement answers every owned priced printing with a baseline; the zero filter, the
/// direction, the order and the limit are applied here, because `since` has to be read over the
/// rows *before* those four narrow them. The row count is the owned printings, not the history.
///
/// Sorted by `|delta|` descending, then name, card id and finish, so two moves of one size come
/// back in the same order on every read.
pub fn movers(
    conn: &Connection,
    window: &str,
    direction: &str,
    market: Marketplace,
    limit: i64,
) -> Result<PriceMovers, String> {
    let limit = limit.clamp(1, MAX_LIMIT) as usize;
    let direction = Direction::parse(direction);
    let (cutoff, order) = Window::parse(window).baseline();

    let sql = format!(
        "WITH owned(card_id, finish, copies) AS ({owned}),
         live AS (
             SELECT o.card_id AS card_id, o.finish AS finish, c.name AS name,
                    c.set_code AS set_code, c.set_name AS set_name, {price} AS now
               FROM owned o
               JOIN cards c ON c.id = o.card_id
              WHERE o.copies > 0
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
        owned = collection_source::copies_by_printing_and_finish(conn, Availability::Everything),
        price = sorting::price_expr(market, "o.finish"),
    );
    let key = market_key(market);

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![key], |r| {
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
        })
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

/// The Price movers widget's read. **Read-only** connection, blocking pool.
///
/// `marketplace` is taken as the enum, whose own `Deserialize` never fails — an id this build does
/// not know is TCGplayer, as on every list query — and as an `Option`, so a caller that sends none
/// gets the same default rather than a refusal.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn price_movers(
    state: tauri::State<'_, Arc<AppState>>,
    window: String,
    direction: String,
    marketplace: Option<Marketplace>,
    limit: i64,
) -> Result<PriceMovers, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        movers(
            &crate::sync::lock_db_read(&state),
            &window,
            &direction,
            marketplace.unwrap_or_default(),
            limit,
        )
    })
    .await
    .map_err(|e| format!("price movers could not be read: {e}"))?
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
/// * **`now` is [`sorting::price_expr`] against the `cards` row, with the finish bound as `?2`**
///   rather than written into the SQL — a scalar subquery, so an id the corpus does not hold is a
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
                price = sorting::price_expr(market, "?2"),
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

/// A mover's detail: one printing's kept history at one marketplace, and its live price.
/// **Read-only** connection, blocking pool, and the marketplace taken as [`price_movers`] takes
/// it — an absent or unknown id is TCGplayer, never a refusal.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn price_history(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
    finish: String,
    marketplace: Option<Marketplace>,
) -> Result<PriceHistory, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        history(
            &crate::sync::lock_db_read(&state),
            &card_id,
            &finish,
            marketplace.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("price history could not be read: {e}"))?
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
