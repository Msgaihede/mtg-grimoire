//! What the reader's collection has been worth on each day this app has looked — in total, or
//! split by card type, colour or set — for the home page's Collection value graph.
//!
//! **One read, [`history`], over the table [`crate::price_history`] writes.** Since user schema
//! v50 each `price_snapshots` row is a **holding** — a printing the reader held that day, with
//! `copies` beside a price that is NULL where the marketplace did not quote it — so a past day's
//! value is `Σ copies × price` over that day's priced rows, and its held set is all of them. Rows
//! written before the upgrade carry NULL `copies` and are **never read**: the graph starts on the
//! upgrade day, because the only quantity a backfill could have used is today's, and that would
//! draw a card bought last week as owned all along.
//!
//! # The rules
//!
//! * **Periods are the table's own thinning, applied again at read time.** A row younger than
//!   [`DAILY_DAYS`] is its own day's period. An older row belongs to its seven-day bucket —
//!   [`crate::price_history::week_bucket`], the prune's exact expression — and within a bucket
//!   only each printing's **latest** row is kept, which is the prune's survivor rule. So a table
//!   the prune has not reached yet (the app was closed for a week, or today's first snapshot has
//!   not run) reads exactly as a thinned one: one point per bucket, never a stray one for the
//!   day a printing was sold mid-week. A period's day is the latest day among its rows.
//! * **The bucket the daily horizon falls in is not read before the horizon.** The prune thins
//!   that bucket's older days against the newer rows in the daily band, so what survives there
//!   is only the printings that *left* during it — read as a period, it would be a stray low
//!   point on six days out of seven. Its daily days are read; its thinned ones are skipped, and
//!   nothing is lost by that: a printing sold in those days is still in the week before and
//!   absent from the day after, so the step between them says it left.
//! * **The last point is today, and it is live.** It is not today's snapshot row — that is an
//!   earlier reading of the same day, and [`crate::price_history::history`]'s rule applies — but
//!   `collection_entries` at today's price, and **its total is [`crate::collection::summarise`]'s
//!   value**, called rather than respelled, so the graph's last point is exactly the number the
//!   Collection value widget prints beside it. An empty collection answers no points at all.
//! * **`moved` is the part of a step that prices made.** For consecutive points A → B, it is the
//!   sum over every printing **held** at both of `A.copies × (B.price − A.price)`, a NULL price
//!   counted as 0; the rest of `B.total − A.total` is what the reader added or removed, which
//!   TypeScript derives. Held means a row in the period, priced or not, and for the live point a
//!   collection entry holding a copy, priced or not. So a price that appears on a card the reader
//!   kept, or vanishes from one, is a price move, and **only a printing entering or leaving the
//!   held set is a collection change** — before v50 an unquoted finish wrote no row, and the
//!   remainder read the price disappearing as the card being sold. An unpriced copy is still
//!   worth nothing in a total, which is [`crate::collection::summarise`]'s arithmetic.
//! * **A card is in exactly one bucket, so the buckets always sum to the total.** The type split
//!   is `deckBuckets.ts`' `typeBucket` — the front face, first match of eight words — so a reader
//!   meets one answer to "what type is this card" across the deck editor and the home page. The
//!   colour split is [`crate::collection::breakdown_columns`]' own `color` key, borrowed rather
//!   than respelled. The set split is the printing's set.
//! * **Rust ranks and caps; TypeScript folds and draws.** Colour is WUBRG, colourless,
//!   multicolour, always in that order. Type and set rank by today's value, `other` last, and at
//!   most [`MAX_NAMED`] named buckets — the rest are summed into `other`, so a collection of two
//!   hundred sets is not two hundred series on the wire. Which of those the widget folds again,
//!   and what it calls them, is the page's.

use crate::price_history::{market_key, week_bucket, DAILY_DAYS, KEEP_DAYS};
use crate::sorting::{self, Marketplace};
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// Refusal for a split word the command does not answer.
pub const NOT_A_SPLIT: &str = "That is not a way to split collection value.";

/// The most named buckets a type or set split answers. Everything past them is summed into
/// `other`, which is always last and never counts against the eight.
pub const MAX_NAMED: usize = 8;

/// The key every bucket the split cannot name — and every one past [`MAX_NAMED`] — is filed
/// under.
const OTHER: &str = "other";

/// `deckBuckets.ts`' `TYPE_BUCKETS`, in its order: **order is the rule** for a card with two
/// types, so an Artifact Creature is a creature and an Artifact Land an artifact.
const TYPE_BUCKETS: [&str; 8] = [
    "Creature",
    "Planeswalker",
    "Instant",
    "Sorcery",
    "Artifact",
    "Enchantment",
    "Battle",
    "Land",
];

/// The colour split's fixed order: WUBRG, then colourless, then multicolour — the keys
/// [`crate::collection::breakdown_columns`]' `color` arm produces.
const COLOR_ORDER: [&str; 7] = ["W", "U", "B", "R", "G", "c", "multi"];

/// One line of the graph.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValueBucket {
    /// "creature".."land" | "other" (type); "W","U","B","R","G","c","multi" (color);
    /// a set code or "other" (set). Empty list for "total".
    pub key: String,
    /// The set's name for split "set" (None for an orphan and for every other split).
    pub name: Option<String>,
}

/// One point on it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValuePoint {
    /// unixepoch() of the period's day (UTC midnight). For a weekly period, its latest day.
    pub day: i64,
    /// Σ copies × price that period; an unpriced holding contributes nothing.
    pub total: f64,
    /// One value per `ValueHistory::buckets`, same order; empty for "total".
    pub values: Vec<f64>,
    /// The price-only part of `total − previous.total`: Σ over printings held at both points of
    /// copies_before × (price_now − price_before), a missing price counted as 0 — so a price
    /// appearing or vanishing on a held card is here, and only a card arriving or leaving is
    /// not. None on the first point.
    pub moved: Option<f64>,
    /// True only for the last point: today, computed live from collection_entries.
    pub live: bool,
}

/// The whole graph.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValueHistory {
    pub buckets: Vec<ValueBucket>,
    /// Oldest first. The last is always today's live point when the collection has any
    /// priced copy; an empty collection answers an empty list.
    pub points: Vec<ValuePoint>,
    /// unixepoch(date('now')) — so the page reads no clock.
    pub today: i64,
}

/// The four ways the value can be cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Split {
    Total,
    Type,
    Color,
    Set,
}

impl Split {
    /// The wire word. **Four arms and a refusal**, never a default: a split this build has not
    /// heard of would otherwise draw the wrong lines under the right label.
    fn parse(word: &str) -> Result<Split, String> {
        match word {
            "total" => Ok(Split::Total),
            "type" => Ok(Split::Type),
            "color" => Ok(Split::Color),
            "set" => Ok(Split::Set),
            _ => Err(NOT_A_SPLIT.to_owned()),
        }
    }

    /// What to bucket by and what to call the bucket, as SQL over the printing aliased `c`.
    /// Every fragment is a literal in this crate; no byte of the request reaches the SQL.
    fn columns(self) -> Result<(String, &'static str), String> {
        match self {
            Split::Total => Ok(("''".to_owned(), "NULL")),
            Split::Type => Ok((type_key(), "NULL")),
            Split::Color => {
                let (key, name) = crate::collection::breakdown_columns("color")?;
                Ok((key.to_owned(), name))
            }
            Split::Set => Ok(("coalesce(c.set_code, 'other')".to_owned(), "c.set_name")),
        }
    }
}

/// `deckBuckets.ts`' `typeBucket`, as SQL over `c.type_line`: the **front face** — everything
/// before the first `//`, the whole line when there is none — and the first of
/// [`TYPE_BUCKETS`] it contains, lowercased; `other` when it contains none, and for a row whose
/// printing has left `cards` (`front(null)` is `""` there too).
///
/// `instr` is case-sensitive, as `String.includes` is, and both count characters rather than
/// bytes, so the em dash in a type line cannot shift the cut. `… || '//'` makes a line with no
/// separator cut at its own end, which is `split("//")[0]` in one expression.
fn type_key() -> String {
    let line = "coalesce(c.type_line, '')";
    let front = format!("substr({line}, 1, instr({line} || '//', '//') - 1)");
    let arms: String = TYPE_BUCKETS
        .iter()
        .map(|word| {
            format!(
                "WHEN instr({front}, '{word}') > 0 THEN '{key}' ",
                key = word.to_lowercase()
            )
        })
        .collect();
    format!("CASE {arms}ELSE '{OTHER}' END")
}

/// The one statement behind every point: the kept snapshot rows, thinned into periods, plus the
/// live collection as one more period at today's date, each printing paired with its own
/// previous period, summed per period and bucket.
///
/// Bound: `?1` the marketplace key, `?2` today (`YYYY-MM-DD`), `?3` the daily horizon, `?4` the
/// keep horizon — all four read once, by [`history`]'s first statement, so a read straddling UTC
/// midnight cannot put a row on both sides of a line.
///
/// * `src` — rows with a count, before today and inside [`KEEP_DAYS`], priced or not; a daily
///   row's period is its day, an older one's its week, and the horizon's own week is read only
///   from the horizon on (the module doc says why).
/// * `kept` — one row per printing per period, its latest, and the period's day as `at`.
/// * `live` — `collection_entries` per printing and finish, at `sorting::price_expr` over the
///   entry's own finish; every printing with a copy is present today, a NULL price included.
/// * `paired` — `lag` over each printing's own sequence of periods; the step counts toward
///   `moved` only when that previous period is the one immediately before, and a NULL price on
///   either side is 0 there, where in a total it is simply not summed.
fn periods_sql(key: &str, name: &str, market: Marketplace) -> String {
    format!(
        "WITH src AS (
             SELECT p.day AS day, p.card_id AS card_id, p.finish AS finish,
                    p.copies AS copies, p.price AS price,
                    CASE WHEN p.day >= ?3 THEN p.day
                         ELSE 'week ' || ({row_week}) END AS period
               FROM price_snapshots p
              WHERE p.marketplace = ?1
                AND p.copies IS NOT NULL
                AND p.day < ?2
                AND p.day >= ?4
                AND (p.day >= ?3 OR {row_week} < {horizon_week})
         ),
         kept AS (
             SELECT card_id, finish, copies, price,
                    max(day) OVER (PARTITION BY period) AS at
               FROM (SELECT s.*,
                            row_number() OVER (PARTITION BY period, card_id, finish
                                               ORDER BY day DESC) AS nth
                       FROM src s)
              WHERE nth = 1
         ),
         live AS (
             SELECT e.card_id AS card_id, e.finish AS finish,
                    sum(e.quantity) AS copies, max({price}) AS price, ?2 AS at
               FROM collection_entries e
               LEFT JOIN cards c ON c.id = e.card_id
              WHERE e.quantity > 0
              GROUP BY e.card_id, e.finish
         ),
         every AS (
             SELECT card_id, finish, copies, price, at FROM kept
             UNION ALL
             SELECT card_id, finish, copies, price, at FROM live
         ),
         seq AS (
             SELECT v.*, dense_rank() OVER (ORDER BY v.at) AS idx FROM every v
         ),
         paired AS (
             SELECT q.*,
                    lag(q.idx) OVER w AS prev_idx,
                    lag(q.copies) OVER w AS prev_copies,
                    lag(q.price) OVER w AS prev_price
               FROM seq q
             WINDOW w AS (PARTITION BY q.card_id, q.finish ORDER BY q.idx)
         )
         SELECT x.at, unixepoch(x.at), x.bucket, max(x.name),
                sum(x.copies * x.price),
                sum(CASE WHEN x.prev_idx = x.idx - 1
                         THEN x.prev_copies
                              * (coalesce(x.price, 0.0) - coalesce(x.prev_price, 0.0))
                         ELSE 0.0 END)
           FROM (SELECT q.*, {key} AS bucket, {name} AS name
                   FROM paired q
                   LEFT JOIN cards c ON c.id = q.card_id) x
          GROUP BY x.idx, x.bucket
          ORDER BY x.idx, x.bucket",
        row_week = week_bucket("p.day"),
        horizon_week = week_bucket("?3"),
        price = sorting::price_expr(market, "e.finish"),
    )
}

/// One period as the statement answers it, before the buckets are arranged.
struct Period {
    /// `YYYY-MM-DD` — today's for the live period.
    at: String,
    day: i64,
    /// Raw bucket key → value, in the statement's order.
    values: Vec<(String, f64)>,
    moved: f64,
}

/// The collection's value over time at `market`, cut by `split` (`total`, `type`, `color` or
/// `set`), oldest point first and today's live point last.
///
/// An unknown split refuses with [`NOT_A_SPLIT`]; an empty collection — no entry holding a copy
/// — answers no buckets and no points, whatever history the table keeps.
pub fn history(
    conn: &Connection,
    split: &str,
    market: Marketplace,
) -> Result<ValueHistory, String> {
    let split = Split::parse(split)?;
    let (key, name) = split.columns()?;

    let (day, today, horizon, keep): (String, i64, String, String) = conn
        .query_row(
            "SELECT d, unixepoch(d), date(d, '-' || ?1 || ' days'), date(d, '-' || ?2 || ' days')
               FROM (SELECT date('now') AS d)",
            params![DAILY_DAYS, KEEP_DAYS],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    // The Collection value widget's own call — `ipc.collectionSummary` with nothing but the
    // marketplace — so the two can never print different numbers for today.
    let summary = crate::collection::summarise(
        conn,
        &crate::collection::CollectionQuery {
            marketplace: market,
            ..Default::default()
        },
    )?;
    if summary.total_cards == 0 {
        return Ok(ValueHistory {
            buckets: Vec::new(),
            points: Vec::new(),
            today,
        });
    }

    let mut periods: Vec<Period> = Vec::new();
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(&periods_sql(&key, name, market))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![market_key(market), day, horizon, keep])
            .map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let at: String = r.get(0).map_err(|e| e.to_string())?;
            let bucket: String = r.get(2).map_err(|e| e.to_string())?;
            let label: Option<String> = r.get(3).map_err(|e| e.to_string())?;
            let value: Option<f64> = r.get(4).map_err(|e| e.to_string())?;
            let moved: Option<f64> = r.get(5).map_err(|e| e.to_string())?;
            if periods.last().map(|p| p.at != at).unwrap_or(true) {
                periods.push(Period {
                    at,
                    day: r.get(1).map_err(|e| e.to_string())?,
                    values: Vec::new(),
                    moved: 0.0,
                });
            }
            let period = periods.last_mut().expect("pushed above");
            period.values.push((bucket.clone(), value.unwrap_or(0.0)));
            period.moved += moved.unwrap_or(0.0);
            let known = names.entry(bucket).or_insert(None);
            if known.is_none() {
                *known = label;
            }
        }
    }

    // Today's period is present whenever a copy is held, priced or not — which the check above
    // has just established — so the `None` arm is defence rather than a state: the live point
    // below is drawn from `summary` either way, and an unpriced collection's is a zero rather
    // than a missing day.
    let live = match periods.last() {
        Some(p) if p.at == day => periods.pop(),
        _ => None,
    };
    let live_values: HashMap<String, f64> = live
        .as_ref()
        .map(|p| p.values.iter().cloned().collect())
        .unwrap_or_default();

    let (buckets, slot) = arrange(split, &periods, live.as_ref(), &live_values, &names);
    let place = |values: &[(String, f64)]| -> Vec<f64> {
        let mut out = vec![0.0; buckets.len()];
        for (k, v) in values {
            if let Some(&i) = slot.get(k) {
                out[i] += v;
            }
        }
        out
    };

    let mut points: Vec<ValuePoint> = periods
        .iter()
        .enumerate()
        .map(|(i, p)| ValuePoint {
            day: p.day,
            total: p.values.iter().map(|(_, v)| v).sum(),
            values: place(&p.values),
            moved: (i > 0).then_some(p.moved),
            live: false,
        })
        .collect();
    let first = points.is_empty();
    points.push(ValuePoint {
        day: today,
        total: summary.value,
        values: place(live.as_ref().map(|p| p.values.as_slice()).unwrap_or(&[])),
        moved: (!first).then(|| live.as_ref().map(|p| p.moved).unwrap_or(0.0)),
        live: true,
    });

    Ok(ValueHistory {
        buckets,
        points,
        today,
    })
}

/// Which buckets the graph draws, in order, and the slot every raw key's money lands in.
///
/// Only a bucket that holds money at **some** point is drawn — a colour the reader has never
/// owned is not a flat line at zero. Colour is [`COLOR_ORDER`]; type and set rank by today's
/// value, highest first, ties by key, then cap at [`MAX_NAMED`] and fold the tail into `other`,
/// which is created for the purpose if the data had none and is always last.
fn arrange(
    split: Split,
    periods: &[Period],
    live: Option<&Period>,
    live_values: &HashMap<String, f64>,
    names: &HashMap<String, Option<String>>,
) -> (Vec<ValueBucket>, HashMap<String, usize>) {
    if split == Split::Total {
        return (Vec::new(), HashMap::new());
    }
    let drawn: BTreeSet<&str> = periods
        .iter()
        .chain(live)
        .flat_map(|p| p.values.iter())
        .filter(|(_, v)| *v != 0.0)
        .map(|(k, _)| k.as_str())
        .collect();

    let mut named: Vec<&str> = drawn.iter().copied().filter(|k| *k != OTHER).collect();
    match split {
        Split::Color => named.sort_by_key(|k| {
            (
                COLOR_ORDER
                    .iter()
                    .position(|c| c == k)
                    .unwrap_or(COLOR_ORDER.len()),
                *k,
            )
        }),
        _ => {
            let worth = |k: &str| live_values.get(k).copied().unwrap_or(0.0);
            named.sort_by(|a, b| worth(b).total_cmp(&worth(a)).then_with(|| a.cmp(b)));
        }
    }
    let folded = if matches!(split, Split::Type | Split::Set) && named.len() > MAX_NAMED {
        named.split_off(MAX_NAMED)
    } else {
        Vec::new()
    };

    let mut buckets: Vec<ValueBucket> = named
        .iter()
        .map(|k| ValueBucket {
            key: (*k).to_owned(),
            name: names.get(*k).cloned().flatten(),
        })
        .collect();
    let mut slot: HashMap<String, usize> = named
        .iter()
        .enumerate()
        .map(|(i, k)| ((*k).to_owned(), i))
        .collect();
    if drawn.contains(OTHER) || !folded.is_empty() {
        let other = buckets.len();
        buckets.push(ValueBucket {
            key: OTHER.to_owned(),
            name: None,
        });
        slot.insert(OTHER.to_owned(), other);
        for k in folded {
            slot.insert(k.to_owned(), other);
        }
    }
    (buckets, slot)
}

/// The Collection value graph's read. **Read-only** connection, blocking pool, and the
/// marketplace taken as `price_movers` takes it — an absent or unknown id is TCGplayer, never a
/// refusal. The split is refused in words when it is not one of the four.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn collection_value_history(
    state: tauri::State<'_, Arc<AppState>>,
    split: String,
    marketplace: Option<Marketplace>,
) -> Result<ValueHistory, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        history(
            &crate::sync::lock_db_read(&state),
            &split,
            marketplace.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("the collection's value history could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection::{summarise, CollectionQuery};

    /// A pair with five printings, each carrying a type line and a colour identity: two priced at
    /// TCGplayer and Cardmarket, one with no price anywhere, one creature, one scheme — and one
    /// Card Kingdom feed row. Nothing is owned yet.
    fn conn() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang,
                                  layout, type_line, color_identity, prices, raw) VALUES
                 ('bolt', 'o1', 'Lightning Bolt', 'lea', 'Alpha', '161', 'en', 'normal',
                  'Instant', 'R', '{"usd":"10.00","usd_foil":"50.00","eur":"8.00"}', '{}'),
                 ('ring', 'o2', 'Sol Ring', 'lea', 'Alpha', '270', 'en', 'normal',
                  'Artifact', '', '{"usd":"100.00","eur":"90.00"}', '{}'),
                 ('free', 'o3', 'Unpriced', 'lea', 'Alpha', '1', 'en', 'normal',
                  'Sorcery', 'B', '{}', '{}'),
                 ('elf', 'o4', 'Llanowar Elves', 'lea', 'Alpha', '2', 'en', 'normal',
                  'Creature — Elf Druid', 'G', '{"usd":"3.00","eur":"2.00"}', '{}'),
                 ('plot', 'o5', 'A Scheme', 'arc', 'Archenemy', '3', 'en', 'normal',
                  'Scheme', '', '{"usd":"500.00"}', '{}');
               INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
                 VALUES ('cardkingdom', 'bolt', 'nonfoil', 12.5);"#,
        )
        .unwrap();
        conn
    }

    /// One entry. `condition` is part of the collection's grain, so two entries of one printing
    /// at one finish differ in it.
    fn own(conn: &Connection, card_id: &str, finish: &str, condition: &str, quantity: i64) {
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, created_at, updated_at)
             VALUES (?1, 'lea', '0', 'en', ?2, ?3, ?4, 0, 0)",
            params![card_id, finish, condition, quantity],
        )
        .unwrap();
    }

    /// A TCGplayer snapshot row `ago` days back, written by hand — the only way a test can have
    /// history. `copies: None` is a row from before user schema v50.
    fn past(
        conn: &Connection,
        ago: i64,
        card_id: &str,
        finish: &str,
        price: f64,
        copies: Option<i64>,
    ) {
        conn.execute(
            "INSERT OR REPLACE INTO price_snapshots (day, marketplace, card_id, finish, price,
                                                     copies)
             VALUES (date('now', '-' || ?1 || ' days'), 'tcgplayer', ?2, ?3, ?4, ?5)",
            params![ago, card_id, finish, price, copies],
        )
        .unwrap();
    }

    /// A held printing's TCGplayer row `ago` days back with **no price** — what a snapshot writes,
    /// since user schema v50, for a finish the marketplace does not quote.
    fn unpriced(conn: &Connection, ago: i64, card_id: &str, finish: &str, copies: i64) {
        conn.execute(
            "INSERT OR REPLACE INTO price_snapshots (day, marketplace, card_id, finish, price,
                                                     copies)
             VALUES (date('now', '-' || ?1 || ' days'), 'tcgplayer', ?2, ?3, NULL, ?4)",
            params![ago, card_id, finish, copies],
        )
        .unwrap();
    }

    /// Each step's collection change — `total − previous total − moved`, TypeScript's
    /// `collectionChange` — which is the number a marker is drawn for.
    fn changes(h: &ValueHistory) -> Vec<f64> {
        h.points
            .windows(2)
            .map(|w| w[1].total - w[0].total - w[1].moved.expect("a step has a moved"))
            .collect()
    }

    fn moved(h: &ValueHistory) -> Vec<Option<f64>> {
        h.points.iter().map(|p| p.moved).collect()
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

    /// The seven-day bucket of the day `ago` days back, by the prune's own expression.
    fn bucket(conn: &Connection, ago: i64) -> i64 {
        conn.query_row(
            &format!(
                "SELECT {}",
                week_bucket("date('now', '-' || ?1 || ' days')")
            ),
            [ago],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn tcg(conn: &Connection, split: &str) -> ValueHistory {
        history(conn, split, Marketplace::Tcgplayer).unwrap()
    }

    fn totals(h: &ValueHistory) -> Vec<f64> {
        h.points.iter().map(|p| p.total).collect()
    }

    fn keys(h: &ValueHistory) -> Vec<&str> {
        h.buckets.iter().map(|b| b.key.as_str()).collect()
    }

    fn cents(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.005
    }

    /// **A database upgraded from v49 has only NULL `copies`**, and a line built from them would
    /// be a fiction: the answer is today's live point and nothing else.
    #[test]
    fn a_history_from_before_the_upgrade_answers_only_the_live_point() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 2);
        for ago in [1, 2, 8, 40, 90] {
            past(&conn, ago, "bolt", "nonfoil", 9.0, None);
        }

        let h = tcg(&conn, "total");

        assert_eq!(h.points.len(), 1, "{h:?}");
        let live = &h.points[0];
        assert!(live.live);
        assert_eq!(live.day, h.today);
        assert_eq!(live.day, day(&conn, 0));
        assert_eq!(live.total, 20.0, "two copies at today's price");
        assert_eq!(live.moved, None, "the first point moved from nothing");
        assert!(
            h.buckets.is_empty() && live.values.is_empty(),
            "total has no buckets"
        );
    }

    /// **Today's live point is the Collection value widget's number**, to the cent, at every
    /// priced marketplace and under every split — over a collection holding a printing twice at
    /// one finish, a foil, an etched copy two marketplaces cannot price, a card no marketplace
    /// prices, an orphan and a zero row. And the buckets add up to it.
    #[test]
    fn the_live_point_is_the_collection_summarys_value() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 2);
        own(&conn, "bolt", "nonfoil", "LP", 1);
        own(&conn, "bolt", "foil", "NM", 1);
        own(&conn, "ring", "etched", "NM", 1);
        own(&conn, "ring", "nonfoil", "NM", 0);
        own(&conn, "free", "nonfoil", "NM", 3);
        own(&conn, "elf", "nonfoil", "NM", 4);
        own(&conn, "gone", "nonfoil", "NM", 1);

        for market in crate::price_history::priced_markets() {
            let summary = summarise(
                &conn,
                &CollectionQuery {
                    marketplace: market,
                    ..Default::default()
                },
            )
            .unwrap();
            for split in ["total", "type", "color", "set"] {
                let h = history(&conn, split, market).unwrap();
                let live = h.points.last().unwrap();
                assert!(live.live);
                assert!(
                    cents(live.total, summary.value),
                    "{market:?} {split}: {} against {}",
                    live.total,
                    summary.value
                );
                if split != "total" {
                    let sum: f64 = live.values.iter().sum();
                    assert!(cents(sum, live.total), "{market:?} {split}: {sum}");
                }
            }
        }
        // And the figure itself, so a summary that went wrong in step cannot hide here:
        // 3 × 10 + 50 + 4 × 3 at TCGplayer — no etched price, none for `free` or the orphan.
        assert_eq!(tcg(&conn, "total").points[0].total, 30.0 + 50.0 + 12.0);
    }

    /// **The price part and the reader's part of each step.** Two copies rise from 8 to 9, a
    /// third is bought at 9, and today all three are worth 10: `moved` is only ever what the
    /// copies held at *both* points did, so `total − previous − moved` is exactly the copy that
    /// was added.
    #[test]
    fn a_step_splits_into_what_prices_moved_and_what_the_reader_added() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 3); // live 10.00 each
        past(&conn, 3, "bolt", "nonfoil", 8.0, Some(2));
        past(&conn, 2, "bolt", "nonfoil", 9.0, Some(2));
        past(&conn, 1, "bolt", "nonfoil", 9.0, Some(3));

        let h = tcg(&conn, "total");

        let days: Vec<i64> = h.points.iter().map(|p| p.day).collect();
        assert_eq!(
            days,
            [day(&conn, 3), day(&conn, 2), day(&conn, 1), day(&conn, 0)]
        );
        assert_eq!(totals(&h), [16.0, 18.0, 27.0, 30.0]);
        let moved: Vec<Option<f64>> = h.points.iter().map(|p| p.moved).collect();
        assert_eq!(moved, [None, Some(2.0), Some(0.0), Some(3.0)]);
        let added = |i: usize| h.points[i].total - h.points[i - 1].total - moved[i].unwrap();
        assert_eq!(added(1), 0.0, "a price rise is not a purchase");
        assert_eq!(added(2), 9.0, "the third copy, at the day's price");
        assert_eq!(added(3), 0.0);
        let live: Vec<bool> = h.points.iter().map(|p| p.live).collect();
        assert_eq!(live, [false, false, false, true]);

        // The type split carries the same money in its one bucket.
        let by_type = tcg(&conn, "type");
        assert_eq!(keys(&by_type), ["instant"]);
        let values: Vec<Vec<f64>> = by_type.points.iter().map(|p| p.values.clone()).collect();
        assert_eq!(values, [[16.0], [18.0], [27.0], [30.0]]);
    }

    /// **A price that vanishes from a card the reader kept is a price move, and so is one that
    /// comes back** — the review finding this test exists for. Two copies at 10, then a day the
    /// marketplace quoted nothing, then 10 again today: the line drops to 0 and climbs back, and
    /// every cent of both steps is `moved`, so neither step is a collection change and neither
    /// draws a marker. The second step is the live one, where the price comes from the corpus.
    #[test]
    fn a_price_that_vanishes_and_returns_on_a_held_card_is_a_price_move() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 2); // live 10.00 each
        past(&conn, 2, "bolt", "nonfoil", 10.0, Some(2));
        unpriced(&conn, 1, "bolt", "nonfoil", 2);

        let h = tcg(&conn, "total");

        assert_eq!(totals(&h), [20.0, 0.0, 20.0]);
        assert_eq!(moved(&h), [None, Some(-20.0), Some(20.0)]);
        assert_eq!(
            changes(&h),
            [0.0, 0.0],
            "the reader sold and bought nothing"
        );
    }

    /// **The same pair of steps the other way round, with the live step the one that loses the
    /// price**: `free` is held throughout, quoted at 5 for one day and at nothing today, because
    /// the corpus has no price for it. Held at both ends of each step is what `moved` asks, so
    /// today's zero is the market's doing and not a sale.
    #[test]
    fn a_price_that_appears_and_vanishes_on_a_held_card_is_a_price_move() {
        let conn = conn();
        own(&conn, "free", "nonfoil", "NM", 2); // held, never priced live
        unpriced(&conn, 2, "free", "nonfoil", 2);
        past(&conn, 1, "free", "nonfoil", 5.0, Some(2));

        let h = tcg(&conn, "type");

        assert_eq!(totals(&h), [0.0, 10.0, 0.0]);
        assert_eq!(moved(&h), [None, Some(10.0), Some(-10.0)]);
        assert_eq!(changes(&h), [0.0, 0.0]);
        assert_eq!(
            keys(&h),
            ["sorcery"],
            "a bucket that held money at some point"
        );
    }

    /// **A genuine add of a card no marketplace quotes changes nothing at all** — not the value,
    /// not `moved`, and so not the collection change either: there is no money for a marker to
    /// mark. The nonfoil `free` arrives between two snapshots and a foil one today, beside a
    /// `ring` held and priced flat throughout.
    #[test]
    fn an_unpriced_card_bought_moves_no_value_and_marks_nothing() {
        let conn = conn();
        own(&conn, "ring", "nonfoil", "NM", 1); // 100.00
        own(&conn, "free", "nonfoil", "NM", 3);
        own(&conn, "free", "foil", "NM", 1); // bought today
        past(&conn, 2, "ring", "nonfoil", 100.0, Some(1));
        past(&conn, 1, "ring", "nonfoil", 100.0, Some(1));
        unpriced(&conn, 1, "free", "nonfoil", 3); // bought yesterday

        let h = tcg(&conn, "type");

        assert_eq!(totals(&h), [100.0, 100.0, 100.0]);
        assert_eq!(moved(&h), [None, Some(0.0), Some(0.0)]);
        assert_eq!(changes(&h), [0.0, 0.0]);
        assert_eq!(keys(&h), ["artifact"], "a bucket worth nothing is no line");
    }

    /// **A thinned table reads as the un-thinned one did with unpriced weeks in it too.** Since
    /// v50 the prune keeps a bucket's newest row *and* its newest priced one, so a week that ends
    /// unquoted leaves two rows behind for one printing — and the read, which keeps the newest per
    /// printing per period, must not turn the extra one into a point or a value.
    #[test]
    fn a_thinned_table_reads_the_same_with_unpriced_rows_in_it() {
        let conn = conn();
        own(&conn, "ring", "nonfoil", "NM", 1);
        own(&conn, "bolt", "nonfoil", "NM", 1);
        for ago in 1..=90 {
            past(&conn, ago, "ring", "nonfoil", 100.0, Some(1));
            if ago % 3 == 0 {
                unpriced(&conn, ago, "bolt", "nonfoil", 1);
            } else {
                past(&conn, ago, "bolt", "nonfoil", ago as f64, Some(1));
            }
        }

        let before = tcg(&conn, "total");
        crate::price_history::prune(&conn, None).unwrap();
        let after = tcg(&conn, "total");

        assert_eq!(before, after);
        assert!(after.points.windows(2).all(|w| w[0].day < w[1].day));
        assert!(
            changes(&after).iter().all(|c| c.abs() < 0.005),
            "two cards held throughout: every step is prices, {:?}",
            changes(&after)
        );
    }

    /// **A printing sold mid-week in the thinned region makes no point of its own**, and the
    /// read is the same before the prune has thinned the table and after. `ring` is held on
    /// every day and priced high, so a point without it is exactly the stray one: the weeks'
    /// survivors of two printings that were sold, read as a period of their own.
    ///
    /// `bolt` leaves the day before the daily horizon, which on six days in seven is inside the
    /// horizon's own week — the week the prune leaves holding only what left. `elf` leaves on a
    /// day whose next day is in the same week, deep in the weekly region.
    #[test]
    fn a_printing_sold_mid_week_makes_no_point_of_its_own() {
        let conn = conn();
        own(&conn, "ring", "nonfoil", "NM", 1);
        for ago in 1..=90 {
            past(&conn, ago, "ring", "nonfoil", 100.0, Some(1));
        }
        for ago in 36..=90 {
            past(&conn, ago, "bolt", "nonfoil", 1.0, Some(1));
        }
        let mid = (55..=65)
            .find(|&ago| bucket(&conn, ago) == bucket(&conn, ago - 1))
            .unwrap();
        for ago in mid..=90 {
            past(&conn, ago, "elf", "nonfoil", 2.0, Some(1));
        }

        let before = tcg(&conn, "total");
        crate::price_history::prune(&conn, None).unwrap();
        let after = tcg(&conn, "total");
        assert_eq!(
            before, after,
            "a thinned table reads as the un-thinned one did"
        );

        // One point per day inside the daily band, one per whole week beyond it, and today.
        let horizon = bucket(&conn, DAILY_DAYS);
        let weeks: BTreeSet<i64> = (36..=90)
            .map(|ago| bucket(&conn, ago))
            .filter(|week| *week < horizon)
            .collect();
        assert_eq!(
            after.points.len(),
            DAILY_DAYS as usize + weeks.len() + 1,
            "{:?}",
            totals(&after)
        );
        assert!(
            after.points.iter().all(|p| p.total >= 100.0),
            "no point is only the printings that left: {:?}",
            totals(&after)
        );
        // The week `elf` left in still counts it — the prune's survivor rule — as one point.
        let elf_week: Vec<f64> = after
            .points
            .iter()
            .filter(|p| p.day >= day(&conn, mid) && p.day < day(&conn, mid - 7))
            .map(|p| p.total)
            .collect();
        assert_eq!(elf_week.len(), 1, "{elf_week:?}");
        assert!(after.points.windows(2).all(|w| w[0].day < w[1].day));
    }

    /// **The type split is `deckBuckets.ts`' `typeBucket`**: the front face, first match in
    /// `TYPE_BUCKETS`' order, `other` for anything else — pinned line by line against the
    /// expression itself, so the TypeScript and the SQL are held to one table.
    #[test]
    fn the_type_split_is_deck_buckets_type_bucket() {
        let conn = conn();
        let key = type_key();
        let bucket_of = |line: Option<&str>| -> String {
            conn.query_row(
                &format!("SELECT {key} FROM (SELECT ?1 AS type_line) c"),
                [line],
                |r| r.get(0),
            )
            .unwrap()
        };
        for (line, want) in [
            ("Artifact Creature — Golem", "creature"),
            ("Artifact Land", "artifact"),
            ("Land Creature — Forest Dryad", "creature"),
            ("Legendary Enchantment Land — Urza’s Saga", "enchantment"),
            ("Instant // Sorcery", "instant"),
            ("Sorcery // Land", "sorcery"),
            ("Kindred Instant — Elf", "instant"),
            ("Token Creature — Soldier", "creature"),
            ("Legendary Planeswalker — Jace", "planeswalker"),
            ("Battle — Siege", "battle"),
            ("Basic Land — Forest", "land"),
            ("Scheme", "other"),
            ("", "other"),
            ("creature", "other"),
        ] {
            assert_eq!(bucket_of(Some(line)), want, "{line}");
        }
        assert_eq!(bucket_of(None), "other", "a printing gone from the corpus");
    }

    /// **Ten sets are eight named and `other`**, ranked by today's value, and `other` holds
    /// exactly the two the cap left out — with each named bucket carrying its set's name.
    #[test]
    fn the_set_split_names_eight_and_sums_the_rest_into_other() {
        let conn = crate::schema::memory_pair();
        for n in 1..=10 {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                    lang, layout, prices, raw)
                 VALUES (?1, ?1, ?1, ?2, ?3, '1', 'en', 'normal', ?4, '{}')",
                params![
                    format!("card{n}"),
                    format!("s{n:02}"),
                    format!("Set {n}"),
                    format!(r#"{{"usd":"{n}.00"}}"#)
                ],
            )
            .unwrap();
            own(&conn, &format!("card{n}"), "nonfoil", "NM", 1);
        }

        let h = tcg(&conn, "set");

        assert_eq!(
            keys(&h),
            ["s10", "s09", "s08", "s07", "s06", "s05", "s04", "s03", "other"]
        );
        assert_eq!(h.buckets[0].name.as_deref(), Some("Set 10"));
        assert_eq!(h.buckets[7].name.as_deref(), Some("Set 3"));
        assert_eq!(h.buckets[8].name, None, "the folded tail is no set");
        let live = h.points.last().unwrap();
        assert_eq!(
            live.values,
            [10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 1.0 + 2.0]
        );
        assert_eq!(live.total, 55.0);
    }

    /// **`other` is last whatever it is worth**, and ties rank by key — on the type split, where
    /// a scheme worth more than everything else still closes the list.
    #[test]
    fn other_closes_the_list_and_ties_rank_by_key() {
        let conn = conn();
        own(&conn, "plot", "nonfoil", "NM", 1); // other, 500
        own(&conn, "ring", "nonfoil", "NM", 1); // artifact, 100
        own(&conn, "bolt", "nonfoil", "NM", 3); // instant, 30
        own(&conn, "elf", "nonfoil", "NM", 10); // creature, 30

        let h = tcg(&conn, "type");

        assert_eq!(keys(&h), ["artifact", "creature", "instant", "other"]);
        assert_eq!(h.points[0].values, [100.0, 30.0, 30.0, 500.0]);
    }

    /// **Colour is WUBRG, colourless, multicolour**, whatever the money says — and only what
    /// held money at some point is drawn, so a colour never owned is no line at all.
    #[test]
    fn the_colour_split_is_fixed_in_order_and_draws_only_what_was_owned() {
        let conn = conn();
        conn.execute_batch(
            r#"INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                  color_identity, prices, raw)
               VALUES ('helix', 'o6', 'Lightning Helix', 'rav', '1', 'en', 'normal', 'RW',
                       '{"usd":"1.00"}', '{}');"#,
        )
        .unwrap();
        own(&conn, "helix", "nonfoil", "NM", 1); // multi, 1
        own(&conn, "ring", "nonfoil", "NM", 1); // c, 100
        own(&conn, "elf", "nonfoil", "NM", 1); // G, 3
        own(&conn, "free", "nonfoil", "NM", 1); // B, but unpriced
        past(&conn, 5, "bolt", "nonfoil", 10.0, Some(1)); // R, sold since

        let h = tcg(&conn, "color");

        assert_eq!(keys(&h), ["R", "G", "c", "multi"]);
        assert_eq!(
            h.points[0].values,
            [10.0, 0.0, 0.0, 0.0],
            "only the bolt, then"
        );
        assert_eq!(h.points[1].values, [0.0, 3.0, 100.0, 1.0]);
    }

    #[test]
    fn an_unknown_split_is_refused_in_words() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 1);
        for word in ["rarity", "", "Type", "finish"] {
            assert_eq!(
                history(&conn, word, Marketplace::Tcgplayer).unwrap_err(),
                NOT_A_SPLIT,
                "{word:?}"
            );
        }
    }

    /// **A row for today or later is not a point**: today's snapshot is an earlier reading of the
    /// day the live point already answers, and a future row is a clock that went wrong.
    #[test]
    fn a_row_for_today_or_later_is_not_a_point() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 2);
        past(&conn, 1, "bolt", "nonfoil", 9.0, Some(2));
        conn.execute_batch(
            "INSERT INTO price_snapshots (day, marketplace, card_id, finish, price, copies) VALUES
                 (date('now'), 'tcgplayer', 'bolt', 'nonfoil', 500.0, 99),
                 (date('now', '+1 day'), 'tcgplayer', 'bolt', 'nonfoil', 700.0, 99);",
        )
        .unwrap();

        let h = tcg(&conn, "total");

        assert_eq!(totals(&h), [18.0, 20.0]);
        assert_eq!(h.points[1].day, h.today);
        assert!(h.points[1].live);
    }

    /// **An empty collection answers nothing**, whatever history the table keeps — the widget's
    /// "nothing owned" rather than a line that ends in a live zero. A row held at zero copies is
    /// no holding either.
    #[test]
    fn an_empty_collection_answers_no_points() {
        let conn = conn();
        past(&conn, 2, "bolt", "nonfoil", 9.0, Some(2));
        assert_eq!(
            tcg(&conn, "type"),
            ValueHistory {
                buckets: Vec::new(),
                points: Vec::new(),
                today: day(&conn, 0)
            }
        );
        own(&conn, "bolt", "nonfoil", "NM", 0);
        assert!(tcg(&conn, "total").points.is_empty());
    }

    /// **A collection with no priced copy still has a today**, at zero — the widget's first-day
    /// state rather than its "nothing owned" one.
    #[test]
    fn an_unpriced_collection_still_has_a_live_point() {
        let conn = conn();
        own(&conn, "free", "nonfoil", "NM", 2);
        past(&conn, 1, "bolt", "nonfoil", 9.0, Some(1));
        let h = tcg(&conn, "type");
        assert_eq!(totals(&h), [9.0, 0.0]);
        assert_eq!(h.points[1].moved, Some(0.0), "nothing was held at both");
        assert!(h.points[1].live);
    }

    /// Another marketplace's rows are someone else's history.
    #[test]
    fn a_history_is_one_marketplace() {
        let conn = conn();
        own(&conn, "bolt", "nonfoil", "NM", 1);
        past(&conn, 1, "bolt", "nonfoil", 9.0, Some(1));
        let cm = history(&conn, "total", Marketplace::Cardmarket).unwrap();
        assert_eq!(totals(&cm), [8.0], "Cardmarket keeps no TCGplayer rows");
        let ck = history(&conn, "total", Marketplace::Cardkingdom).unwrap();
        assert_eq!(
            totals(&ck),
            [12.5],
            "a feed marketplace prices through its own table"
        );
    }

    #[test]
    fn the_dtos_serialise_under_the_names_the_page_reads() {
        let v = serde_json::to_value(ValueHistory {
            buckets: vec![ValueBucket {
                key: "lea".into(),
                name: Some("Limited Edition Alpha".into()),
            }],
            points: vec![ValuePoint {
                day: 1_800_000_000,
                total: 2.5,
                values: vec![2.5],
                moved: None,
                live: true,
            }],
            today: 1_800_000_000,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "buckets": [{ "key": "lea", "name": "Limited Edition Alpha" }],
                "points": [{
                    "day": 1_800_000_000, "total": 2.5, "values": [2.5],
                    "moved": null, "live": true
                }],
                "today": 1_800_000_000
            })
        );
    }
}
