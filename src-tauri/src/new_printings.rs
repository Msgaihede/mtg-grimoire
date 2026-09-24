//! Reprints of cards the reader's watched decks already hold, newest first, grouped by release
//! day by the page that draws them.
//!
//! **Two statements over one `WHERE`, which is [`crate::card::list_printings`]' shape and is here
//! for a sharper reason.** The page is one statement and the decks holding each of its printings
//! is a second. A single join to `deck_cards` would multiply a printing by the decks holding it
//! and then need distinct-ing back down, which is how the issue's *each printing appears only
//! once* requirement gets quietly broken — and the count beside it would be wrong in the same
//! breath. [`NewPrintings::decks_watched`] is taken over the **same** predicate the page is, for
//! `card::PrintingsResponse::total`'s reason: a count over a wider `WHERE` than the rows is
//! exactly the lie a count is added to prevent.
//!
//! **No schema change.** Every column this reads already exists: `cards.released_at`,
//! `cards.oracle_id` (narrowed by `idx_cards_oracle`), `cards.is_paper`, `cards.lang`,
//! `cards.type_line`, `cards.{image_uris,face_image_uris}` (read through [`crate::image_uri`]),
//! `deck_cards.{card_id,deck_id,quantity,variant}` and `decks.virtual_only`.
//! `cards` is named unqualified because the corpus is `ATTACH`ed — every query in this crate
//! names it that way, and a `corpus.cards` here would be the one statement that disagreed.
//!
//! **The language set is the reader's, and it is the one argument here that decides how many rows
//! a reprint is.** `cards.id` is one printing *in one language*, so a set that ships in ten
//! languages is ten rows of one reprint — which is noise for a reader who wanted a feed and
//! exactly right for one who collects in two languages. So [`Ask::langs`] is an allow-list:
//! **empty is every language**, and the page's default sends `["en"]`, which is one row per
//! reprint. [`crate::card::list_printings`] filters language not at all, because a printings
//! *list* is supposed to show them; the difference is that a list is a reader choosing which
//! cardboard they own and a feed is a reader asking what is new.
//!
//! The list is **bounded here as well as narrowed in TypeScript**, because it arrives from a
//! `config` a reader can hand-edit: an entry that is not two to four lowercase letters is dropped
//! and the list is capped at `MAX_LANGS`. A list the narrowing empties is every language — the
//! same rule as an empty list, never a fallback to English, which would be this module making a
//! claim the caller did not.
//!
//! **`released_at` is nullable in the corpus and is not on the wire.** A printing with no date
//! cannot be placed in a day group, so the `WHERE` drops it rather than the body inventing an
//! *Undated* bucket.
//!
//! **The cursor is `app_meta`'s**, [`crate::recent_cards`]' shape exactly and for its reason:
//! `config` round-trips through older builds, and a cursor an older build rewrites is a cursor
//! that lies. An unreadable row reads as *never seen*, which draws every dot — the honest
//! failure, where reading it as *now* would silently hide the whole point of the mark.
//!
//! **Two things this deliberately does not narrow by**, both because nothing asked it to and a
//! filter nobody asked for is a row the reader cannot get back:
//!
//! * **An archived deck is watched like any other.** `decks.archived` reserves availability; it
//!   is not a statement that the reader has stopped caring what happens to the cards in it, and
//!   there is no switch on the widget for it. If one is ever wanted it belongs on [`Ask`] beside
//!   the other three, where the page can say so.
//! * **A printing a watched deck already holds is still a reprint.** The question is *what came
//!   out lately of what you play*, not *what you are missing*, and the deck popover names the
//!   copies either way.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the application's, deliberately not `sync_meta` — a mark
/// about what *this screen* has shown is this device's, like every stored preference here.
pub const K_NEW_PRINTINGS_SEEN: &str = "new_printings_seen";

/// How many printings one read asks for — the command's own clamp, and the ceiling the page's
/// `NEW_PRINTINGS_READ` matches. **The box cuts this to whole rows**; a read sized to the rows
/// that fit would re-issue on every drag of the resize corner and paint *pending* over a list
/// that was already right. `RecentCardsWidget` and `PriceMoversWidget` both say this at their
/// own sites.
pub const NEW_PRINTINGS_READ: i64 = 100;

/// The longest window the feed will answer, in days. A hand-edited `config` cannot ask for the
/// whole corpus, and the registry offers 30, 90 and 365.
const MAX_DAYS: i64 = 365;

/// How many language codes an allow-list may carry. `src/lib/languages.ts` names **19**, which is
/// every code across the 116 712 rows of the 2026-08-18 bulk, so 24 clears the corpus with room
/// and refuses a list that could only be a bug.
const MAX_LANGS: usize = 24;

/// What a basic land's `type_line` looks like, as a `LIKE` pattern.
///
/// **`Basic %Land%` rather than `Basic Land%`**, because `Basic Snow Land — Forest` is a basic
/// land too and a reader who unticked the switch did not mean *except the snow ones*. The
/// `%` after `Basic ` is what lets the supertype and the type be separated by another supertype;
/// the one after `Land` is the subtype (`— Forest`) and Wastes' absence of one.
///
/// A literal, never a needle: no byte of the request reaches this pattern, so `LIKE`'s three
/// metacharacters have nothing to escape — which is the opposite of `combos`' search, where the
/// needle is typed and the answer is `instr` for exactly that reason.
const BASIC_LAND_LIKE: &str = "Basic %Land%";

/// Is this a language code at all? The corpus's are two to four lowercase letters (`en`, `zhs`,
/// `grc`). A shape check rather than a membership test against the known 19: a language Scryfall
/// adds next set is the reader's own data arriving early, and refusing it here would need this
/// file edited before a feed could show it.
fn is_lang_code(code: &str) -> bool {
    (2..=4).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase())
}

/// The window, clamped. **A zero or a negative is a caller bug rather than a request for an empty
/// window**, and is answered with one day — the narrowest honest answer. Never passed through:
/// a negative `LIMIT` is SQLite's *no limit at all*, which is the trap [`crate::deck_audit`]'s
/// clamp exists for, and the same shape of mistake one field over.
fn window_days(days: i64) -> i64 {
    days.clamp(1, MAX_DAYS)
}

/// The page size, clamped into `0..=NEW_PRINTINGS_READ`. `None` is the full read.
///
/// **A negative is zero rows and not the default**, which is where this parts from
/// [`crate::card::list_printings`]' `page_size`: there an empty page would be indistinguishable
/// from *this card has no printings*, the one thing that list must never say by accident, so a
/// bad number falls back to a real page. Here an empty feed is an ordinary answer with four
/// sentences of its own, so a caller that asked for nothing is given nothing — and what both
/// rules have in common is the one that matters, that a negative never reaches SQLite, which
/// would read it as the whole join.
fn page_size(limit: Option<i64>) -> i64 {
    match limit {
        Some(n) if n > 0 => n.min(NEW_PRINTINGS_READ),
        Some(_) => 0,
        None => NEW_PRINTINGS_READ,
    }
}

/// One deck holding the card a [`NewPrinting`] is a reprint of.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrintingDeck {
    /// `decks.id`.
    pub deck_id: i64,
    /// The deck's name, for the popover row.
    pub name: String,
    /// Copies of the card this deck holds, **summed across its categories and both variants**.
    /// A deck holding a card in a live category and a theory one is one entry with the total,
    /// never two rows that draw identically and sum apart.
    pub quantity: i64,
    /// `live` where any live row holds it, else `theory` — see [`feed`]'s second statement for
    /// why this is a `min()` and not a group.
    pub variant: String,
    /// Whether this is a deck the reader tracks without owning the cardboard (`decks.virtual_only`,
    /// user schema v40). On the wire because the popover marks one.
    pub virtual_only: bool,
}

/// One reprinted printing, and the watched decks that hold the card.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrinting {
    /// `cards.id` — one printing **in one language**, which is why [`NewPrinting::lang`] is on
    /// the wire.
    pub printing_id: String,
    /// `cards.oracle_id`, which is what the decks were matched on.
    pub oracle_id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    /// `YYYY-MM-DD`. **Never null** — a printing with no date cannot be placed in a day group,
    /// so the `WHERE` drops it rather than the page inventing an *Undated* bucket.
    pub released_at: String,
    pub rarity: Option<String>,
    pub promo_types: Option<String>,
    pub finishes: Option<String>,
    /// `cards.lang`. **On the wire because a row must be able to say it**: a reader asking for
    /// every language gets one row per language of a reprint, and without this they are
    /// identical-looking rows that read as a duplicated list.
    pub lang: String,
    /// The printing's front-face picture per variant, from [`crate::image_uri::front_face_map`] —
    /// the crate's one rule for which column, which face and which host, read here rather than
    /// respelled. **On the wire because the web and Android targets draw only a URL they are
    /// handed** — `cardArtSrc` ignores the `mtgimg://` route there — so without it their thumb is
    /// blank. `None` for a printing with no fetchable picture anywhere, never an empty map.
    pub image_uris: Option<BTreeMap<String, String>>,
    /// The watched decks holding this card, by deck name.
    pub decks: Vec<NewPrintingDeck>,
}

/// The feed, and the three facts that travel beside it.
///
/// **An empty `printings` means one of three different things** and a count of zero cannot tell
/// them apart: no deck is watched, nothing was reprinted inside the window, or the window is
/// shorter than the reader's decks are old. [`NewPrintings::decks_watched`],
/// [`NewPrintings::since`] and [`NewPrintings::oldest`] are what the page reads to pick its
/// sentence — `PriceMovers`' `days` and `since` are the same device one widget over.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPrintings {
    pub printings: Vec<NewPrinting>,
    /// How many decks the scope resolved to, over the **same** predicate the page ran under.
    /// This is what lets the page say *no decks are being watched* rather than *nothing was
    /// reprinted*.
    pub decks_watched: i64,
    /// The far edge of the window, `YYYY-MM-DD`, after the clamp — so a page that asked for
    /// 99 999 days can draw the date it actually got.
    pub since: String,
    /// The release day of the last row on the page, or `None` when there are none. A page cut
    /// by the limit can say what it is a truncation *of* without a second count.
    pub oldest: Option<String>,
    /// When this device last saw the feed, unix seconds. `None` is *never*, which draws every
    /// dot — see the module doc for why an unreadable row reads that way too.
    pub seen_at: Option<i64>,
}

/// Everything one read of the feed is narrowed by. Built by the command wrappers from the
/// widget's `config`, and narrowed again here — see [`feed`].
#[derive(Debug, Clone)]
pub struct Ask {
    /// `chosen` reads [`Ask::deck_ids`]; **anything else is every deck**. Two arms and not
    /// three: `decks` has no `pinned` column, a pinned set is a *widget's* `deckIds`, so
    /// `chosen` is the only id-carrying scope there can be.
    pub scope: String,
    /// The decks `chosen` names. Ignored under every other scope.
    pub deck_ids: Vec<i64>,
    /// How far back to look, clamped into `1..=MAX_DAYS`.
    pub days: i64,
    /// The languages to answer in. **Empty is every language** — the allow-list's one sentinel,
    /// and the same rule at both ends of the wire.
    pub langs: Vec<String>,
    /// Whether a deck the reader owns no cardboard for contributes cards.
    pub include_virtual: bool,
    /// Whether a theory row counts as *held*.
    pub include_theory: bool,
    /// Whether a basic land the decks hold can be reprinted onto the feed.
    pub include_basics: bool,
    /// The page size, clamped into `0..=NEW_PRINTINGS_READ`. `None` is the full read.
    pub limit: Option<i64>,
}

/// The `decks` predicate for one scope, as static SQL.
///
/// **No byte of the request reaches the text.** The ids go in through `json_each` on a bound
/// parameter, because they come off a hand-editable `config` and `rarray` is not registered in
/// this crate — formatting an id list into SQL is the one thing this function exists not to do.
///
/// **`?1` is named in both arms on purpose.** SQLite counts a statement's parameters by the
/// *largest* index it mentions, so binding an index the text never uses is legal as long as the
/// largest one is present; naming it here anyway keeps one binding order for both scopes, where
/// a predicate that dropped the parameter would renumber everything after it. The `all` arm's
/// `?1 IS NOT NULL` is always true, since the caller always hands it a JSON string.
///
/// An unknown word is `all` — `pickOf`'s rule restated where a hand-edited row can reach.
fn scope_predicate(scope: &str) -> &'static str {
    match scope {
        "chosen" => "d.id IN (SELECT value FROM json_each(?1))",
        _ => "?1 IS NOT NULL",
    }
}

/// The watched decks, as a CTE body. Used by all three statements so none of them can be taken
/// over a different set of decks than the others.
fn watched_cte(scope: &str) -> String {
    format!(
        "SELECT d.id AS id, d.name AS name, d.virtual_only AS virtual_only
           FROM decks d
          WHERE ({scope}) AND (?2 OR d.virtual_only = 0)",
        scope = scope_predicate(scope)
    )
}

/// The reprints, newest first, and the watched decks holding each.
///
/// **Two statements, and the second is over the oracle ids the first answered.** The page cannot
/// be a join to `deck_cards` — see the module doc — so the decks are fetched after the page is
/// known, which also means the popover's rows are exactly the rows on screen rather than a
/// second, wider question asked at the same time.
///
/// Everything the caller sent is narrowed here as well as in TypeScript, because `config` is a
/// row a reader can hand-edit: `days` into `1..=MAX_DAYS`, `limit` into
/// `0..=`[`NEW_PRINTINGS_READ`], an unknown `scope` into `all`, and `langs` to codes of the
/// right shape capped at `MAX_LANGS`. **A list the narrowing empties is every language**, which
/// is the same rule as an empty list rather than a different one — a fallback to English would
/// be this build making a claim the caller did not.
pub fn feed(conn: &Connection, ask: &Ask) -> Result<NewPrintings, String> {
    let days = window_days(ask.days);
    let since: String = conn
        .query_row("SELECT date('now', ?1)", [format!("-{days} days")], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;

    // `chosen` with no ids is a real answer and never *every deck*: the reader chose a set and it
    // is empty. One bound parameter, walked by `json_each`; nothing is formatted into SQL.
    let ids_json = serde_json::to_string(&ask.deck_ids).map_err(|e| e.to_string())?;
    // **Empty is every language**, at both ends — see the module doc. The narrowing can empty a
    // list the caller filled, and that is the same answer rather than a different one.
    let langs: Vec<&str> = ask
        .langs
        .iter()
        .map(String::as_str)
        .filter(|code| is_lang_code(code))
        .take(MAX_LANGS)
        .collect();
    let every_language = langs.is_empty();
    let langs_json = serde_json::to_string(&langs).map_err(|e| e.to_string())?;
    let watched = watched_cte(&ask.scope);

    /// Where the page's image expressions start — one past `p.lang`, the last named column.
    /// Named for `deck_notes::attachments_by_note`'s reason: a number left behind when a named
    /// column lands reads one slot's URL as another's and nothing errors. A read one column
    /// *early* still answers a real URL — the card-level picture where the face's belongs — so
    /// `tests::a_printing_carries_its_front_face_picture` carries a different URL in each slot.
    const IMAGE_COL: usize = 11;
    let images = crate::image_uri::front_face_selects("p").join(", ");

    // Statement 1 — the page. `held` is the distinct oracle ids the watched decks hold, and the
    // basics switch is applied *there* rather than on the page: a type line is a fact about the
    // oracle card, so both ends give the same answer, and narrowing the held set is the cheaper
    // one. `oracle_id <> ''` is the fence `card::list_printings` states — the column is nullable,
    // and a blank on both sides of the join would make every card that lacked one a "printing"
    // of each other.
    let page_sql = format!(
        "WITH watched AS ({watched}),
         held AS (
             SELECT DISTINCT c.oracle_id AS oracle_id
               FROM deck_cards dc
               JOIN watched w ON w.id = dc.deck_id
               JOIN cards c ON c.id = dc.card_id
              WHERE c.oracle_id IS NOT NULL AND c.oracle_id <> ''
                AND (?3 OR dc.variant = 'live')
                AND (?4 OR coalesce(c.type_line, '') NOT LIKE ?9)
         )
         SELECT p.id, p.oracle_id, p.name, p.set_code, p.set_name, p.collector_number,
                p.released_at, p.rarity, p.promo_types, p.finishes, p.lang,
                {images}
           FROM cards p
           JOIN held h ON h.oracle_id = p.oracle_id
          WHERE p.is_paper = 1
            AND (?5 OR p.lang IN (SELECT value FROM json_each(?6)))
            AND p.released_at IS NOT NULL
            AND p.released_at >= ?7
          ORDER BY p.released_at DESC, p.set_code ASC, p.collector_number ASC, p.id ASC
          LIMIT ?8"
    );
    let mut stmt = conn.prepare(&page_sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![
                ids_json,
                ask.include_virtual,
                ask.include_theory,
                ask.include_basics,
                every_language,
                langs_json,
                since,
                page_size(ask.limit),
                BASIC_LAND_LIKE,
            ],
            |r| {
                Ok(NewPrinting {
                    printing_id: r.get(0)?,
                    oracle_id: r.get(1)?,
                    name: r.get(2)?,
                    set_code: r.get(3)?,
                    set_name: r.get(4)?,
                    collector_number: r.get(5)?,
                    released_at: r.get(6)?,
                    rarity: r.get(7)?,
                    promo_types: r.get(8)?,
                    finishes: r.get(9)?,
                    lang: r.get(10)?,
                    image_uris: crate::image_uri::front_face_map(|i| r.get(IMAGE_COL + i))?,
                    decks: Vec::new(),
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let mut printings = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut by_oracle = decks_holding(conn, &watched, ask, &printings)?;
    for printing in &mut printings {
        if let Some(decks) = by_oracle.remove(&printing.oracle_id) {
            printing.decks = decks;
        }
    }

    // The count is taken over the **same** predicate as the page, never a wider one: a reader
    // whose only deck is virtual must be told *no decks are being watched*, which is a different
    // sentence from *nothing was reprinted*, and a count that saw the deck anyway would pick the
    // wrong one.
    let decks_watched: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM decks d WHERE ({scope}) AND (?2 OR d.virtual_only = 0)",
                scope = scope_predicate(&ask.scope)
            ),
            params![ids_json, ask.include_virtual],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(NewPrintings {
        oldest: printings.last().map(|p| p.released_at.clone()),
        printings,
        decks_watched,
        since,
        seen_at: seen_at(conn),
    })
}

/// Statement 2 — the watched decks holding each oracle card on the page, keyed by oracle id.
///
/// **`GROUP BY c.oracle_id, w.id` and not the variant**, which is the whole of the quantity rule:
/// a deck holding a card in a live category and a theory one is one popover row with the total,
/// where grouping the variant too would draw two rows that look identical and sum apart — the
/// worst shape a bug in this list can have. The variant it reports is `min()`, which is `live`
/// wherever any live row holds it because `'live' < 'theory'`; that is the honest answer for a
/// row whose copies are partly each, and the alternative — a third word — would be a vocabulary
/// `deck_cards.variant`'s CHECK does not have.
///
/// **The basics switch is not repeated here.** A basic land the page excluded contributes no
/// oracle id to the `IN` list, so the filter is already applied; the theory switch *is* repeated,
/// because it changes which rows are summed rather than which cards are asked about.
///
/// An empty page asks nothing at all — there is no list for `json_each` to walk.
fn decks_holding(
    conn: &Connection,
    watched: &str,
    ask: &Ask,
    printings: &[NewPrinting],
) -> Result<HashMap<String, Vec<NewPrintingDeck>>, String> {
    let mut out: HashMap<String, Vec<NewPrintingDeck>> = HashMap::new();
    if printings.is_empty() {
        return Ok(out);
    }
    let mut oracles: Vec<&str> = printings.iter().map(|p| p.oracle_id.as_str()).collect();
    oracles.sort_unstable();
    oracles.dedup();
    let oracles_json = serde_json::to_string(&oracles).map_err(|e| e.to_string())?;

    let sql = format!(
        "WITH watched AS ({watched})
         SELECT c.oracle_id, w.id, w.name, w.virtual_only,
                min(dc.variant), sum(dc.quantity)
           FROM deck_cards dc
           JOIN watched w ON w.id = dc.deck_id
           JOIN cards c ON c.id = dc.card_id
          WHERE c.oracle_id IN (SELECT value FROM json_each(?4))
            AND (?3 OR dc.variant = 'live')
          GROUP BY c.oracle_id, w.id
          ORDER BY w.name ASC, w.id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![
                serde_json::to_string(&ask.deck_ids).map_err(|e| e.to_string())?,
                ask.include_virtual,
                ask.include_theory,
                oracles_json,
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    NewPrintingDeck {
                        deck_id: r.get(1)?,
                        name: r.get(2)?,
                        virtual_only: r.get(3)?,
                        variant: r.get(4)?,
                        quantity: r.get(5)?,
                    },
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (oracle_id, deck) = row.map_err(|e| e.to_string())?;
        out.entry(oracle_id).or_default().push(deck);
    }
    Ok(out)
}

/// When this device last saw the feed, or `None` for never.
///
/// **A row this build cannot read is *never*, not *now*.** Drawing every dot over a feed the
/// reader has already seen costs them one glance; hiding the mark over one they have not is the
/// whole point of the cursor quietly not happening.
fn seen_at(conn: &Connection) -> Option<i64> {
    crate::app_meta::get_app_meta(conn, K_NEW_PRINTINGS_SEEN)?
        .trim()
        .parse::<i64>()
        .ok()
}

/// Move the *seen* cursor to `at`, in unix seconds.
///
/// The clock is the caller's for [`crate::recent_cards::record`]'s reason: `SystemTime::now()`
/// panics on `wasm32-unknown-unknown` rather than erroring, and this module is on the
/// every-target half of the map.
pub fn mark_seen(conn: &Connection, at: i64) -> Result<(), String> {
    crate::app_meta::set_app_meta(conn, K_NEW_PRINTINGS_SEEN, &at.to_string())
        .map_err(|e| format!("the new printings you have seen could not be recorded: {e}"))
}

/// The New printings widget's read. **Read-only** connection, blocking pool — as every read in
/// this app is, so the home page never queues behind a sync.
///
/// **Every argument is the widget's `config` narrowed on the way out of TypeScript**, and every
/// one is narrowed again here: `days` into `1..=MAX_DAYS`, `limit` into
/// `0..=`[`NEW_PRINTINGS_READ`], an unknown `scope` into `all`, and `langs` to codes of the right
/// shape, capped at `MAX_LANGS`. A hand-edited row cannot ask for the whole corpus.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn new_printings(
    state: tauri::State<'_, Arc<AppState>>,
    scope: String,
    deck_ids: Vec<i64>,
    days: i64,
    langs: Vec<String>,
    include_virtual: bool,
    include_theory: bool,
    include_basics: bool,
    limit: Option<i64>,
) -> Result<NewPrintings, String> {
    let state = state.inner().clone();
    let ask = Ask {
        scope,
        deck_ids,
        days,
        langs,
        include_virtual,
        include_theory,
        include_basics,
        limit,
    };
    tauri::async_runtime::spawn_blocking(move || feed(&crate::sync::lock_db_read(&state), &ask))
        .await
        .map_err(|e| format!("the new printings could not be read: {e}"))?
}

/// Move the *seen* cursor to `at`. The clock is the **caller's**, never `SystemTime::now()`,
/// which panics on the wasm target — [`crate::recent_cards::record`]'s rule, one command over.
///
/// Answers [`crate::db::BUSY`] if a sync holds the write connection, like every write command
/// here. **The caller ignores a refusal**: a cursor that did not move costs a row of gold dots
/// the reader has already looked at, and a widget that raised an error over it would be worse.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn mark_new_printings_seen(
    state: tauri::State<'_, Arc<AppState>>,
    at: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| mark_seen(conn, at))
    })
    .await
    .map_err(|e| format!("the new printings you have seen could not be recorded: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real pair, because the page joins `deck_cards` in the user file to `cards` in the
    /// attached corpus and the cursor is an `app_meta` row beside them — a single hand-built
    /// database could not see a statement that reached for the wrong one.
    ///
    /// **`crate::schema::memory_pair()` is what that helper is called**, and it answers a bare
    /// `Connection` rather than a connection and a guard.
    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    /// Every ask the tests vary from — 90 days, all decks, the issue's three defaults.
    fn ask() -> Ask {
        Ask {
            scope: "all".into(),
            deck_ids: vec![],
            days: 90,
            langs: vec!["en".into()],
            include_virtual: false,
            include_theory: true,
            include_basics: false,
            limit: None,
        }
    }

    /// One printing in the corpus. `released_at` is `days_ago` days before today, so a window is
    /// testable without a clock injected into the query.
    ///
    /// Eight arguments, and every one of them is a column some test in this module varies. The
    /// obvious cure — a struct with a `Default` — would be a shape nothing else in this file has,
    /// for a helper whose whole body is one `INSERT`; `deck.rs` makes the same trade at its own
    /// eight-column seeder.
    #[allow(clippy::too_many_arguments)]
    fn printing(
        c: &Connection,
        id: &str,
        oracle: &str,
        name: &str,
        set: &str,
        days_ago: i64,
        lang: &str,
        type_line: &str,
    ) {
        c.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang,
                                layout, released_at, is_paper, type_line, raw)
             VALUES (?1, ?2, ?3, ?4, 'Set ' || ?4, '1', ?5, 'normal',
                     date('now', '-' || ?6 || ' days'), 1, ?7, '{}')",
            params![id, oracle, name, set, lang, days_ago, type_line],
        )
        .unwrap();
    }

    /// One deck and the one category its cards are filed under — `deck_cards.category_id` is an
    /// enforced key and `memory_pair` turns foreign keys on, so the pile has to exist.
    fn deck(c: &Connection, id: i64, name: &str, virtual_only: bool) {
        c.execute(
            "INSERT INTO decks (id, name, format_key, virtual_only, created_at, updated_at)
             VALUES (?1, ?2, 'commander', ?3, 0, 0)",
            params![id, name, virtual_only],
        )
        .unwrap();
        c.execute(
            "INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
             VALUES (?1, ?1, 'Main deck', 'main', 1, 0, 0, 0)",
            params![id],
        )
        .unwrap();
    }

    /// One deck holding one printing, at `variant`.
    fn holds(c: &Connection, deck_id: i64, card_id: &str, qty: i64, variant: &str) {
        c.execute(
            "INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, created_at, updated_at)
             VALUES (?1, ?1, ?2, ?3, 'x', '1', 'en', ?3, ?4, 0, 0)",
            params![deck_id, variant, card_id, qty],
        )
        .unwrap();
    }

    /// **The requirement the whole two-statement shape exists for.** A single join to `deck_cards`
    /// would answer this printing twice and then need distinct-ing back down, which is how the
    /// issue's "each printing appears only once" gets quietly broken.
    #[test]
    fn a_printing_two_decks_hold_appears_once_with_two_decks() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        deck(&c, 2, "Edgar", false);
        holds(&c, 1, "old", 1, "live");
        holds(&c, 2, "old", 1, "live");
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings.len(), 1, "one row for one printing");
        assert_eq!(out.printings[0].printing_id, "new");
        assert_eq!(out.printings[0].decks.len(), 2);
        assert_eq!(
            out.printings[0]
                .decks
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            ["Atraxa", "Edgar"],
            "by deck name"
        );
        assert_eq!(out.decks_watched, 2);
        assert_eq!(
            out.oldest.as_deref(),
            Some(out.printings[0].released_at.as_str())
        );
    }

    /// The quantity is summed across a deck's categories, so a deck holding a card in both a live
    /// and a theory category is **one** entry with the total rather than two entries.
    #[test]
    fn a_decks_quantity_sums_across_its_categories() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 2, "live");
        holds(&c, 1, "old", 3, "theory");
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings[0].decks.len(), 1);
        assert_eq!(out.printings[0].decks[0].quantity, 5);
        assert_eq!(
            out.printings[0].decks[0].variant, "live",
            "a deck holding it both ways is a live deck"
        );
    }

    #[test]
    fn a_basic_land_is_dropped_unless_asked_for() {
        let c = conn();
        printing(
            &c,
            "old",
            "o1",
            "Forest",
            "LEA",
            900,
            "en",
            "Basic Land — Forest",
        );
        printing(
            &c,
            "new",
            "o1",
            "Forest",
            "SLD",
            10,
            "en",
            "Basic Land — Forest",
        );
        // Snow lands are basic lands too, and a reader who unticked the switch did not mean
        // *except the snow ones*.
        printing(
            &c,
            "snow-old",
            "o2",
            "Snow-Covered Forest",
            "CSP",
            900,
            "en",
            "Basic Snow Land — Forest",
        );
        printing(
            &c,
            "snow-new",
            "o2",
            "Snow-Covered Forest",
            "MH1",
            10,
            "en",
            "Basic Snow Land — Forest",
        );
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        holds(&c, 1, "snow-old", 1, "live");
        assert!(feed(&c, &ask()).unwrap().printings.is_empty());
        let out = feed(
            &c,
            &Ask {
                include_basics: true,
                ..ask()
            },
        )
        .unwrap();
        assert_eq!(out.printings.len(), 2);
    }

    /// A non-basic land is not a basic land, which is what keeps the pattern from taking the
    /// switch's word for a whole card type.
    #[test]
    fn an_ordinary_land_is_not_a_basic_one() {
        let c = conn();
        printing(&c, "old", "o1", "Command Tower", "CMD", 900, "en", "Land");
        printing(&c, "new", "o1", "Command Tower", "SLD", 10, "en", "Land");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        assert_eq!(feed(&c, &ask()).unwrap().printings.len(), 1);
    }

    #[test]
    fn a_virtual_deck_contributes_nothing_by_default() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Ideas", true);
        holds(&c, 1, "old", 1, "live");
        let out = feed(&c, &ask()).unwrap();
        assert!(out.printings.is_empty());
        // **And `decks_watched` is zero too** — the count is what the scope resolved to, which is
        // what lets the page say *no decks are being watched* rather than *nothing was reprinted*.
        assert_eq!(out.decks_watched, 0);
        let out = feed(
            &c,
            &Ask {
                include_virtual: true,
                ..ask()
            },
        )
        .unwrap();
        assert_eq!(out.printings.len(), 1);
        assert_eq!(out.decks_watched, 1);
        assert!(out.printings[0].decks[0].virtual_only, "and it says so");
    }

    #[test]
    fn a_theory_row_contributes_only_when_asked_for() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "theory");
        assert!(feed(
            &c,
            &Ask {
                include_theory: false,
                ..ask()
            }
        )
        .unwrap()
        .printings
        .is_empty());
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings.len(), 1);
        assert_eq!(out.printings[0].decks[0].variant, "theory");
    }

    /// **Decision 2, and the whole of it.** `cards.id` is one printing *in one language*, so
    /// the language set is what decides whether a second language is a second row — and each of
    /// the three modes the page offers is a real answer here.
    #[test]
    fn the_language_set_decides_whether_a_second_language_is_a_second_row() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new-en", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        printing(&c, "new-ja", "o1", "Sol Ring", "SLD", 10, "ja", "Artifact");
        printing(&c, "new-de", "o1", "Sol Ring", "SLD", 10, "de", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");

        // English — the default, and the issue's deduplication requirement.
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings.len(), 1);
        assert_eq!(out.printings[0].printing_id, "new-en");
        assert_eq!(
            out.printings[0].lang, "en",
            "the row says which language it is"
        );

        // Every language — an **empty** list, and three rows is what the reader asked for.
        let every = feed(
            &c,
            &Ask {
                langs: vec![],
                ..ask()
            },
        )
        .unwrap();
        assert_eq!(every.printings.len(), 3);

        // Chosen — English and Japanese, and not German.
        let two = feed(
            &c,
            &Ask {
                langs: vec!["en".into(), "ja".into()],
                ..ask()
            },
        )
        .unwrap();
        assert_eq!(two.printings.len(), 2);
        assert!(!two.printings.iter().any(|p| p.lang == "de"));
    }

    /// The list arrives from a `config` a reader can hand-edit, so it is bounded here as well as
    /// narrowed in TypeScript. **A list emptied by the narrowing is every language**, which is the
    /// same rule as an empty list — never a silent fallback to English, which would be this build
    /// making a claim the caller did not.
    #[test]
    fn a_hand_edited_language_list_is_bounded() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new-en", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        printing(&c, "new-ja", "o1", "Sol Ring", "SLD", 10, "ja", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        // A SQL fragment, an empty string, a 40-character word and a capitalised code are all
        // dropped — the codes in the corpus are lowercase.
        let junk = vec![
            "en' OR 1=1 --".into(),
            String::new(),
            "x".repeat(40),
            "EN".into(),
        ];
        assert_eq!(
            feed(
                &c,
                &Ask {
                    langs: junk,
                    ..ask()
                }
            )
            .unwrap()
            .printings
            .len(),
            2,
            "every entry was dropped, so every language"
        );
        // And a list of 24 junk entries plus a real one past the cap is still bounded rather than
        // refused: the narrowing runs first, so the cap counts codes rather than characters.
        let long: Vec<String> = std::iter::repeat_n("zz".to_owned(), MAX_LANGS + 8).collect();
        assert!(feed(
            &c,
            &Ask {
                langs: long,
                ..ask()
            }
        )
        .unwrap()
        .printings
        .is_empty());
    }

    /// A printing with no release date cannot be placed in a day group, so the `WHERE` drops it
    /// rather than the body inventing an *Undated* bucket. `released_at` is therefore never null
    /// on the wire.
    #[test]
    fn an_undated_printing_is_dropped_rather_than_bucketed() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        c.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                                layout, released_at, is_paper, type_line, raw)
             VALUES ('undated','o1','Sol Ring','SLD','1','en','normal',NULL,1,'Artifact','{}')",
            [],
        )
        .unwrap();
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        assert!(feed(&c, &ask()).unwrap().printings.is_empty());
    }

    /// A reprint carries its front-face picture through `image_uri`'s one rule, and a printing
    /// with no blob carries `None` rather than an empty map.
    ///
    /// **`meld` carries a different URL in each of its four slots** — `display` and `art`,
    /// card-level and face 0 — because that is the only shape an `IMAGE_COL` one column early
    /// fails on: the pair is (top-level, face) and `for_face` prefers the face, so the shear
    /// slides each card-level URL into the face slot and answers a real, versioned, on-host URL.
    /// `plain` is the ordinary card, whose picture is in the top-level blob alone and which
    /// that shear reads correctly by accident.
    #[test]
    fn a_printing_carries_its_front_face_picture() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "plain", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        printing(&c, "meld", "o1", "Sol Ring", "CMR", 10, "en", "Artifact");
        printing(&c, "bare", "o1", "Sol Ring", "LTC", 10, "en", "Artifact");
        // An UPDATE rather than two more arguments on `printing`, which every other test calls
        // and none of them about pictures.
        c.execute(
            "UPDATE cards SET image_uris = json_object(
                 'thumb','https://cards.scryfall.io/thumb/front/p/l/plain.webp?1700000000',
                 'grid','https://cards.scryfall.io/grid/front/p/l/plain.webp?1700000000',
                 'display','https://cards.scryfall.io/display/front/p/l/plain.webp?1700000000',
                 'art','https://cards.scryfall.io/art/front/p/l/plain.webp?1700000000')
             WHERE id = 'plain'",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE cards SET
                 image_uris = json_object(
                   'display','https://cards.scryfall.io/display/CARD.webp?1',
                   'art','https://cards.scryfall.io/art/CARD.webp?1'),
                 face_image_uris = json_array(
                   json_object('display','https://cards.scryfall.io/display/FACE.webp?1',
                               'art','https://cards.scryfall.io/art/FACE.webp?1'))
             WHERE id = 'meld'",
            [],
        )
        .unwrap();
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");

        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings.len(), 3);
        let images = |id: &str| {
            out.printings
                .iter()
                .find(|p| p.printing_id == id)
                .unwrap_or_else(|| panic!("`{id}` is on the page"))
                .image_uris
                .clone()
        };

        let plain = images("plain").expect("a top-level blob is a picture");
        assert_eq!(
            plain["display"],
            "https://cards.scryfall.io/display/front/p/l/plain.webp?1700000000"
        );
        assert_eq!(
            plain["art"],
            "https://cards.scryfall.io/art/front/p/l/plain.webp?1700000000"
        );

        // The face wins over the card for both variants, and each variant reads its own pair.
        let meld = images("meld").expect("both columns are a picture");
        assert_eq!(
            meld["display"],
            "https://cards.scryfall.io/display/FACE.webp?1"
        );
        assert_eq!(meld["art"], "https://cards.scryfall.io/art/FACE.webp?1");

        assert_eq!(images("bare"), None, "no blob is no picture, never `{{}}`");
    }

    /// The window is the caller's, inside `1..=365`, so a hand-edited `config` cannot ask for the
    /// whole corpus — and a negative is not "no limit", which is the trap `deck_audit`'s clamp
    /// exists for and which SQLite reads as *unlimited*.
    #[test]
    fn the_window_and_the_limit_are_clamped() {
        let c = conn();
        assert_eq!(
            feed(
                &c,
                &Ask {
                    days: 99_999,
                    ..ask()
                }
            )
            .unwrap()
            .since,
            feed(&c, &Ask { days: 365, ..ask() }).unwrap().since
        );
        assert_eq!(
            feed(&c, &Ask { days: -5, ..ask() }).unwrap().since,
            feed(&c, &Ask { days: 1, ..ask() }).unwrap().since
        );

        // **Seeded, because a limit assertion over an empty database proves nothing.** A negative
        // passed through to SQLite is *no limit at all*, which on an empty corpus answers zero
        // rows exactly as the clamp does.
        deck(&c, 1, "Atraxa", false);
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        holds(&c, 1, "old", 1, "live");
        for (i, set) in ["SLD", "CMR", "LTC"].iter().enumerate() {
            printing(
                &c,
                &format!("new-{i}"),
                "o1",
                "Sol Ring",
                set,
                10,
                "en",
                "Artifact",
            );
        }
        assert_eq!(feed(&c, &ask()).unwrap().printings.len(), 3);
        assert_eq!(
            feed(
                &c,
                &Ask {
                    limit: Some(-1),
                    ..ask()
                }
            )
            .unwrap()
            .printings
            .len(),
            0,
            "a negative is no rows, never the whole join"
        );
        assert_eq!(
            feed(
                &c,
                &Ask {
                    limit: Some(2),
                    ..ask()
                }
            )
            .unwrap()
            .printings
            .len(),
            2
        );
        assert_eq!(
            feed(
                &c,
                &Ask {
                    limit: Some(9_999),
                    ..ask()
                }
            )
            .unwrap()
            .printings
            .len(),
            3,
            "and anything past the ceiling is the ceiling"
        );
    }

    /// The scope, and the one thing `chosen` must not do: read `deck_ids` under any other word.
    #[test]
    fn chosen_reads_the_ids_and_the_other_scopes_ignore_them() {
        let c = conn();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        deck(&c, 2, "Edgar", false);
        holds(&c, 1, "old", 1, "live");
        holds(&c, 2, "old", 1, "live");
        let chosen = Ask {
            scope: "chosen".into(),
            deck_ids: vec![2],
            ..ask()
        };
        let out = feed(&c, &chosen).unwrap();
        assert_eq!(out.decks_watched, 1);
        assert_eq!(
            out.printings[0].decks.len(),
            1,
            "and the page's popover too"
        );
        assert_eq!(out.printings[0].decks[0].name, "Edgar");

        let all = Ask {
            deck_ids: vec![2],
            ..ask()
        };
        assert_eq!(
            feed(&c, &all).unwrap().decks_watched,
            2,
            "`all` ignores the ids"
        );
        // A word this build has never heard of is `all` rather than a refusal.
        let future = Ask {
            scope: "aScopeFromALaterBuild".into(),
            deck_ids: vec![2],
            ..ask()
        };
        assert_eq!(feed(&c, &future).unwrap().decks_watched, 2);
        // An empty `chosen` is a real answer and never *every deck*.
        let none = Ask {
            scope: "chosen".into(),
            deck_ids: vec![],
            ..ask()
        };
        let none = feed(&c, &none).unwrap();
        assert_eq!(none.decks_watched, 0);
        assert!(none.printings.is_empty());
    }

    /// The cursor is `app_meta`'s, for `recent_cards`' reason: `config` round-trips through older
    /// builds, and a cursor an older build rewrites is a cursor that lies.
    #[test]
    fn the_seen_cursor_round_trips_and_a_junk_row_reads_as_never() {
        let c = conn();
        assert_eq!(feed(&c, &ask()).unwrap().seen_at, None);
        mark_seen(&c, 1_700_000_000).unwrap();
        assert_eq!(feed(&c, &ask()).unwrap().seen_at, Some(1_700_000_000));
        for junk in ["not a number", "", "1.5", "{\"at\":1}"] {
            crate::app_meta::set_app_meta(&c, K_NEW_PRINTINGS_SEEN, junk).unwrap();
            assert_eq!(
                feed(&c, &ask()).unwrap().seen_at,
                None,
                "`{junk}` reads as never"
            );
        }
        mark_seen(&c, 1_700_000_001).unwrap();
        assert_eq!(feed(&c, &ask()).unwrap().seen_at, Some(1_700_000_001));
    }

    /// The wire names the page reads — the half `ipc.test.ts`'s field parity cannot see, because
    /// it applies the camel step whether or not serde does.
    #[test]
    fn every_dto_serialises_under_the_names_the_page_reads() {
        let wire = serde_json::to_value(NewPrintings {
            printings: vec![NewPrinting {
                printing_id: "p".into(),
                oracle_id: "o".into(),
                name: "Sol Ring".into(),
                set_code: "sld".into(),
                set_name: None,
                collector_number: "1".into(),
                released_at: "2026-09-01".into(),
                rarity: Some("rare".into()),
                promo_types: None,
                finishes: None,
                lang: "en".into(),
                image_uris: Some(BTreeMap::from([(
                    "display".to_owned(),
                    "https://cards.scryfall.io/display/front/p/p/p.webp?1".to_owned(),
                )])),
                decks: vec![NewPrintingDeck {
                    deck_id: 3,
                    name: "Atraxa".into(),
                    quantity: 2,
                    variant: "live".into(),
                    virtual_only: false,
                }],
            }],
            decks_watched: 1,
            since: "2026-06-03".into(),
            oldest: Some("2026-09-01".into()),
            seen_at: None,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "printings": [{
                    "printingId": "p", "oracleId": "o", "name": "Sol Ring", "setCode": "sld",
                    "setName": null, "collectorNumber": "1", "releasedAt": "2026-09-01",
                    "rarity": "rare", "promoTypes": null, "finishes": null, "lang": "en",
                    "imageUris": {
                        "display": "https://cards.scryfall.io/display/front/p/p/p.webp?1"
                    },
                    "decks": [{ "deckId": 3, "name": "Atraxa", "quantity": 2,
                                "variant": "live", "virtualOnly": false }]
                }],
                "decksWatched": 1, "since": "2026-06-03", "oldest": "2026-09-01", "seenAt": null
            })
        );
    }

    /// A corpus with no `cards` table at all — the state between a destroyed corpus and its first
    /// sync — is an error in a sentence rather than a panic, which is what the command wrapper
    /// hands the page.
    #[test]
    fn a_corpus_without_cards_is_a_sentence_rather_than_a_panic() {
        let c = conn();
        c.execute_batch("DROP TABLE corpus.cards").unwrap();
        let err = feed(&c, &ask()).unwrap_err();
        assert!(err.contains("cards"), "{err}");
    }
}
