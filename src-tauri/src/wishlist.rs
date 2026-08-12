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

use crate::collection::{valid_quantity, EntryChange, BUSY, FINISHES};
use crate::filters::{escape_like, LIKE_ESCAPE};
use crate::schema::WISHLIST_GRAIN;
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
    /// Which currency the `cost` and `price` sorts order by. Absent — or anything this build
    /// does not recognise — means `usd`. [`crate::collection::CollectionQuery`]'s field,
    /// verbatim; see [`crate::sorting::Currency`].
    pub currency: crate::sorting::Currency,
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
    /// any-printing wish, because that join coalesces to the newest printing of the wish's
    /// oracle card. So a wish for the card is described as well as a wish for the cardboard,
    /// and only a genuine orphan (no pinned printing, no oracle match) answers `None`. Same
    /// `None` as `rarity` and `mana_cost` beside it, for the same reason.
    pub type_line: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    /// The cheapest way to satisfy this wish, per copy: the preferred finish's price if one
    /// is named, else the nonfoil price of the printing (or of any printing of the oracle
    /// card, for an unpinned wish).
    pub unit_price_usd: Option<f64>,
    /// The same in EUR, with the hole the data actually has: **`eur_etched` does not
    /// exist**, so a wish for the etched printing is unpriced in euros rather than quoted
    /// at the nonfoil rate. [`crate::collection::FINISH_PRICE_EUR`]'s rule, re-expressed
    /// over the wish's preferred finish rather than over an entry's own.
    pub unit_price_eur: Option<f64>,
    /// How many copies the collection already has against this wish.
    pub owned_quantity: i64,
    pub notes: Option<String>,
    pub needs_review: Option<String>,
    pub updated_at: i64,
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
/// `sum(quantity)`, so a collection row emptied to zero (which the collection keeps — see
/// [`crate::collection::set_quantity`]) contributes nothing: this figure is copies held,
/// not entries recorded, and a wish is satisfied by copies.
const OWNED_SQL: &str = "coalesce((
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

/// `cost` and `price`, in each currency.
///
/// `cost` is what finishing the wish still costs — unit price over the copies *missing*,
/// which is the figure the Cost cell prints and which is zero for a fulfilled wish however
/// dear the card is. `price` is what one copy costs, and stays reachable from the select.
///
/// All four order by **output aliases** rather than by any column of either table, so a
/// rename there is a `prepare` error at run time; `every_sort_key_prepares…` is what catches
/// it, and it now runs every key in both currencies. The euro pair carries the hole the data
/// has: a wish for the *etched* printing is NULL in euros and sorts last, because there is no
/// `eur_etched` key to quote it from.
const WISHLIST_PRICE_SORTS: &[crate::sorting::PricedSort] = &[
    crate::sorting::PricedSort {
        usd: crate::sorting::SortColumn {
            key: "cost",
            asc: "unit_price_usd * max(0, w.quantity - owned_quantity) ASC NULLS LAST",
            desc: "unit_price_usd * max(0, w.quantity - owned_quantity) DESC NULLS LAST",
        },
        eur: crate::sorting::SortColumn {
            key: "cost",
            asc: "unit_price_eur * max(0, w.quantity - owned_quantity) ASC NULLS LAST",
            desc: "unit_price_eur * max(0, w.quantity - owned_quantity) DESC NULLS LAST",
        },
    },
    crate::sorting::PricedSort {
        usd: crate::sorting::SortColumn {
            key: "price",
            asc: "unit_price_usd ASC NULLS LAST",
            desc: "unit_price_usd DESC NULLS LAST",
        },
        eur: crate::sorting::SortColumn {
            key: "price",
            asc: "unit_price_eur ASC NULLS LAST",
            desc: "unit_price_eur DESC NULLS LAST",
        },
    },
];

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

    let sql = format!(
        "INSERT INTO wishlist_entries
            (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
             preferred_finish, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, unixepoch(), unixepoch())
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

/// The oracle card's name, read from whichever printing the list would join to.
///
/// Same ordering as [`list_wishes`]' `LEFT JOIN` on purpose: the name stored on the row and
/// the printing the list reads a rarity and a price from are then the same card.
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

pub fn list_wishes(conn: &Connection, q: &WishlistQuery) -> Result<WishlistPage, String> {
    let limit = if q.limit == 0 {
        DEFAULT_LIMIT
    } else {
        q.limit.min(MAX_LIMIT)
    };
    let mut p = crate::filters::Predicates::default();
    // The card a wish is *about*: its pinned printing, or any printing of its oracle card.
    // A LEFT JOIN, because a wish outlives the printing it was made from.
    let from = "wishlist_entries w LEFT JOIN cards c
                    ON c.id = coalesce(w.card_id,
                        (SELECT id FROM cards WHERE oracle_id = w.oracle_id
                          ORDER BY released_at DESC, id ASC LIMIT 1))";
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
    match q.fulfilled {
        Some(true) => p.wheres.push(format!("{OWNED_SQL} >= w.quantity")),
        Some(false) => p.wheres.push(format!("{OWNED_SQL} < w.quantity")),
        None => {}
    }
    // [`crate::collection::scope`]'s three-way match, over this table's column. Pushed
    // before the count is taken, so the header cannot count rows the list will not show.
    match q.needs_review {
        Some(true) => p.wheres.push("w.needs_review IS NOT NULL".to_owned()),
        Some(false) => p.wheres.push("w.needs_review IS NULL".to_owned()),
        None => {}
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
        &crate::sorting::sorts_for(WISHLIST_SORTS, WISHLIST_PRICE_SORTS, q.currency),
        "w.name ASC",
        "w.id ASC",
    );
    let sql = format!(
        "SELECT w.id, w.oracle_id, w.card_id, w.name, w.set_code, w.collector_number, w.lang,
                c.rarity, c.mana_cost, w.quantity, w.preferred_finish,
                CAST(json_extract(c.prices,
                    CASE coalesce(w.preferred_finish, 'nonfoil')
                        WHEN 'foil' THEN '$.usd_foil'
                        WHEN 'etched' THEN '$.usd_etched'
                        ELSE '$.usd' END) AS REAL) AS unit_price_usd,
                CASE coalesce(w.preferred_finish, 'nonfoil') WHEN 'etched' THEN NULL ELSE
                    CAST(json_extract(c.prices,
                        CASE coalesce(w.preferred_finish, 'nonfoil')
                            WHEN 'foil' THEN '$.eur_foil'
                            ELSE '$.eur' END) AS REAL) END AS unit_price_eur,
                {OWNED_SQL} AS owned_quantity,
                w.notes, w.needs_review, w.updated_at,
                -- Appended rather than placed beside `c.mana_cost` where it belongs in the
                -- struct: every `r.get(n)` below is a positional index, so inserting a column
                -- mid-list renumbers eight of them by hand. Last costs one index and nothing
                -- else.
                c.type_line
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
                    type_line: r.get(17)?,
                    quantity: r.get(9)?,
                    preferred_finish: r.get(10)?,
                    unit_price_usd: r.get(11)?,
                    unit_price_eur: r.get(12)?,
                    owned_quantity: r.get(13)?,
                    notes: r.get(14)?,
                    needs_review: r.get(15)?,
                    updated_at: r.get(16)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(WishlistPage { items, total })
}

/// Run `f` with the write connection, or answer [`BUSY`] — the wishlist's copy of the bound
/// [`crate::collection`] documents: a button press on a worker thread, and the only thing
/// that can hold `AppState.db` is a sync taking it one batch at a time.
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(BUSY.to_owned()),
    }
}

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

/// The wishlist. **Read-only** connection, blocking pool — as every read in this app is.
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

    /// One sort term, in the shape the UI sends.
    fn term(key: &str, dir: &str) -> crate::sorting::SortTerm {
        crate::sorting::SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
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
        conn
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
            quantity: 4,
            preferred_finish: Some("foil".into()),
            unit_price_usd: Some(40.0),
            unit_price_eur: Some(32.0),
            owned_quantity: 2,
            notes: None,
            needs_review: None,
            updated_at: 1_800_000_000,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "oracleId": "o1", "cardId": null, "name": "Lightning Bolt",
                "setCode": null, "collectorNumber": null, "lang": null, "rarity": "common",
                "manaCost": "{R}", "typeLine": "Instant", "quantity": 4, "preferredFinish": "foil",
                "unitPriceUsd": 40.0, "unitPriceEur": 32.0, "ownedQuantity": 2, "notes": null,
                "needsReview": null, "updatedAt": 1800000000
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
        assert_eq!(row.unit_price_usd, None);
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
                .unit_price_usd
        };
        assert_eq!(price_of(None), Some(5.0));
        assert_eq!(price_of(Some("foil")), Some(40.0));
        assert_eq!(
            price_of(Some("etched")),
            None,
            "no etched price is not the nonfoil price"
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

    /// EUR per copy follows the wish's own finish, with the hole the data has: a foil wish
    /// prices at eur_foil, an etched wish is NULL — unpriced, never the nonfoil rate.
    #[test]
    fn unit_price_eur_reads_the_blob_by_preferred_finish_and_etched_is_unpriced() {
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

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let eur_of = |finish: Option<&str>| {
            rows.items
                .iter()
                .find(|r| r.preferred_finish.as_deref() == finish)
                .unwrap()
                .unit_price_eur
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

        // A wish whose printing has left `cards` is unpriced in both currencies: there is no
        // blob to read, in either.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();
        let orphaned = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        assert!(orphaned
            .items
            .iter()
            .all(|r| r.unit_price_eur.is_none() && r.unit_price_usd.is_none()));
    }

    /// Three wishes whose dollar order and euro order disagree on every pair, one of them for
    /// the **etched** printing — whose blob names a `$.eur` that the etched wish must not
    /// take. Quantities differ too, so `cost` and `price` cannot agree by accident.
    fn seeded_currencies() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, prices) in [
            ("cheap-usd", r#"{"usd":"1.00","eur":"90.00"}"#),
            ("dear-usd", r#"{"usd":"50.00","eur":"2.00"}"#),
            ("etched", r#"{"usd":"9.00","usd_etched":"9.00","eur":"7.00"}"#),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,raw)
                 VALUES (?1,?1,?1,'tst','1','en','normal',?2,'{}')",
                rusqlite::params![id, prices],
            )
            .unwrap();
        }
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
    /// both directions, both currencies — and the etched wish, unpriced on Cardmarket, stays
    /// last whichever way the euro sort runs.
    #[test]
    fn the_cost_and_price_sorts_order_by_the_currency_they_are_asked_for() {
        let conn = seeded_currencies();
        let names = |key: &str, dir: &str, currency| -> Vec<String> {
            list_wishes(
                &conn,
                &WishlistQuery {
                    sort: Some(vec![term(key, dir)]),
                    currency,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .into_iter()
            .map(|r| r.name)
            .collect()
        };
        let (usd, eur) = (crate::sorting::Currency::Usd, crate::sorting::Currency::Eur);

        // Per copy: $1 / $50 / $9 against €90 / €2 / —.
        assert_eq!(
            names("price", "asc", usd),
            ["cheap-usd", "etched", "dear-usd"]
        );
        assert_eq!(
            names("price", "asc", eur),
            ["dear-usd", "cheap-usd", "etched"]
        );
        assert_eq!(
            names("price", "desc", usd),
            ["dear-usd", "etched", "cheap-usd"]
        );
        assert_eq!(
            names("price", "desc", eur),
            ["cheap-usd", "dear-usd", "etched"]
        );

        // × the copies still missing, and nothing is owned: $10 / $50 / $18 against
        // €900 / €2 / —.
        assert_eq!(names("cost", "asc", usd), ["cheap-usd", "etched", "dear-usd"]);
        assert_eq!(names("cost", "asc", eur), ["dear-usd", "cheap-usd", "etched"]);
        assert_eq!(
            names("cost", "desc", usd),
            ["dear-usd", "etched", "cheap-usd"]
        );
        assert_eq!(
            names("cost", "desc", eur),
            ["cheap-usd", "dear-usd", "etched"]
        );
    }

    /// The euro orders are *different strings* over a second select alias, so each is its own
    /// chance to fail at **prepare** time — the whole list, and only ever on Cardmarket.
    #[test]
    fn every_sort_key_prepares_in_euros_too() {
        let conn = seeded_currencies();
        for key in ["name", "owned", "quantity", "cost", "price", "added", "nope"] {
            for dir in ["asc", "desc"] {
                let page = list_wishes(
                    &conn,
                    &WishlistQuery {
                        sort: Some(vec![term(key, dir)]),
                        currency: crate::sorting::Currency::Eur,
                        ..Default::default()
                    },
                )
                .unwrap_or_else(|e| panic!("sorting by `{key}` {dir} in euros failed: {e}"));
                assert_eq!(page.items.len(), 3);
            }
        }
    }

    /// Absent means dollars — the order every caller had before there was a picker — and so
    /// does a currency this build has never heard of.
    #[test]
    fn a_query_with_no_currency_sorts_in_dollars() {
        let conn = seeded_currencies();
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

        let dollars = ["cheap-usd", "etched", "dear-usd"];
        assert_eq!(names(&format!("{{{sort}}}")), dollars, "absent");
        assert_eq!(
            names(&format!(r#"{{{sort},"currency":"gbp"}}"#)),
            dollars,
            "and a currency this build has never heard of"
        );
        assert_eq!(
            names(&format!(r#"{{{sort},"currency":"eur"}}"#)),
            ["dear-usd", "cheap-usd", "etched"]
        );
    }
}
