//! **The reads the Durable Object renders** — the bot's whole read surface, each one narrow SQL
//! over the group's rows joined to the slim corpus ([`crate::corpus`]).
//!
//! Rust supplies facts, TypeScript draws conclusions: every function here answers rows, and the
//! Durable Object's script (`infrastructure/bot-device/src/render.ts`) turns them into a Discord
//! embed, a line of text or a deck list. Nothing here knows what a message looks like.
//!
//! **Every answer is bounded** ([`MAX_LINES`], [`MAX_NAMES`]) and says how much it left out, so a
//! card held in four hundred rows is still one small answer and the embed can say *and N more*.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The most lines one card's answer carries. A Discord embed's description holds 4 096
/// characters; at about sixty a line this is well inside it, and [`Holding::more`] counts the rest.
pub const MAX_LINES: usize = 40;

/// The most choices an autocomplete may offer — Discord's own cap.
pub const MAX_NAMES: usize = 25;

/// The longest name or value an autocomplete choice may carry — Discord's own cap, in characters.
pub const MAX_CHOICE_CHARS: usize = 100;

/// What `/collection search` and `/wishlist search` answer about one card.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    /// The card's name as the corpus spells it (or as the wish does, for a wish the corpus has
    /// no printing of).
    pub name: String,
    /// Scryfall's `normal` image of one printing held, or `None` when the corpus has none yet.
    pub image: Option<String>,
    pub type_line: Option<String>,
    /// Copies across every line, the ones past [`MAX_LINES`] included.
    pub total: i64,
    /// One line a printing, finish and folder, most copies first.
    pub lines: Vec<Line>,
    /// Lines left out past [`MAX_LINES`].
    pub more: usize,
}

/// One printing in one finish in one folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub quantity: i64,
    /// `None` for a wish that is for any printing.
    pub set_name: Option<String>,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    /// `nonfoil`, `foil` or `etched` — or `None` for a wish with no preference.
    pub finish: Option<String>,
    /// The folder path, `Binder/Artifacts`, or `None` at the root.
    pub folder: Option<String>,
    /// The printing's USD price in this finish, when the corpus has one.
    pub price_usd: Option<f64>,
}

/// One autocomplete choice: what is shown, and what the command is handed back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub name: String,
    pub value: String,
}

/// A deck, for the `/deck` autocomplete and its answer's title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    /// The deck's `sync_uid` — the same on every device of the group.
    pub uid: String,
    pub name: String,
    pub format: String,
    /// Copies in the live list, every pile.
    pub cards: i64,
}

/// One deck card in the shape `packages/ui/features/transfer/TransferCard.ts` declares, field for
/// field, so the Durable Object hands it to the TypeScript export writer as it is.
///
/// **Every field a deck does not have is `null`**, which is that file's own rule: `null` means the
/// surface does not have the fact. The thirty keys are the interface's; `deck_cards_are_transfer_
/// cards` in this module's tests and `infrastructure/bot-device/src/deck.test.ts` both pin them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCard {
    pub name: String,
    pub quantity: i64,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    /// `null`, `foil` or `etched` — the deck's spelling (`DeckFinish`).
    pub finish: Option<String>,
    pub lang: Option<String>,
    pub category_name: Option<String>,
    pub category_kind: Option<String>,
    pub category_active: Option<bool>,
    pub condition: Option<String>,
    pub tradelist_quantity: Option<i64>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub grading: Option<String>,
    pub altered: Option<bool>,
    pub signed: Option<bool>,
    pub proxy: Option<bool>,
    pub misprint: Option<bool>,
    pub tags: Option<String>,
    pub notes: Option<String>,
    pub set_name: Option<String>,
    pub rarity: Option<String>,
    pub type_line: Option<String>,
    pub unit_price: Option<f64>,
    pub label_name: Option<String>,
    pub label_color: Option<String>,
    pub legalities: Option<String>,
}

/// What `/deck` answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckList {
    pub deck: DeckSummary,
    /// In the deck's own pile order, then by name — the order a list is read in.
    pub cards: Vec<TransferCard>,
}

fn err(e: rusqlite::Error) -> String {
    format!("the bot's database could not be read: {e}")
}

/// `name` as a `LIKE` pattern's literal part.
fn escaped(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Cut `text` to `max` characters — never through one.
pub fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => text[..at].to_owned(),
        None => text.to_owned(),
    }
}

/// The folder path of every collection folder, root first, `/` between — the CTE both reads use.
const COLLECTION_PATHS: &str = "WITH RECURSIVE paths(id, path) AS (
        SELECT id, name FROM collection_folders WHERE parent_id IS NULL
        UNION ALL
        SELECT f.id, p.path || '/' || f.name
          FROM collection_folders f JOIN paths p ON f.parent_id = p.id
    )";

const WISHLIST_PATHS: &str = "WITH RECURSIVE paths(id, path) AS (
        SELECT id, name FROM wishlist_folders WHERE parent_id IS NULL
        UNION ALL
        SELECT f.id, p.path || '/' || f.name
          FROM wishlist_folders f JOIN paths p ON f.parent_id = p.id
    )";

/// The USD price of a printing in a finish, from the corpus row's `prices` — the finish's own
/// figure, then the row's headline one.
const PRICE_IN_FINISH: &str = "coalesce(
        CASE ?finish
            WHEN 'foil' THEN CAST(json_extract(c.prices, '$.usd_foil') AS REAL)
            WHEN 'etched' THEN CAST(json_extract(c.prices, '$.usd_etched') AS REAL)
            ELSE CAST(json_extract(c.prices, '$.usd') AS REAL)
        END,
        c.price_usd)";

fn price_in(finish_column: &str) -> String {
    PRICE_IN_FINISH.replace("?finish", finish_column)
}

/// The image of a corpus row: Scryfall's `normal`, the front face's, then the `display` WEBP.
const IMAGE_OF: &str = "coalesce(
        json_extract(c.image_uris, '$.normal'),
        json_extract(c.face_image_uris, '$[0].normal'),
        json_extract(c.image_uris, '$.display'),
        json_extract(c.face_image_uris, '$[0].display'))";

/// The corpus name a typed `name` means, among the names `candidates` (a `SELECT name …` over
/// the rows asked about): the same name, any case; else the front face of a double-faced card;
/// else the first that begins with it. `None` when nothing does.
fn resolve(conn: &Connection, candidates: &str, name: &str) -> Result<Option<String>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    let sql = format!(
        "SELECT name FROM ({candidates})
          WHERE name = ?1 COLLATE NOCASE
             OR name LIKE ?2 ESCAPE '\\'
             OR name LIKE ?3 ESCAPE '\\'
          ORDER BY CASE WHEN name = ?1 COLLATE NOCASE THEN 0
                        WHEN name LIKE ?2 ESCAPE '\\' THEN 1
                        ELSE 2 END,
                   length(name), name
          LIMIT 1"
    );
    let face = format!("{} // %", escaped(name));
    let prefix = format!("{}%", escaped(name));
    conn.query_row(&sql, params![name, face, prefix], |r| r.get(0))
        .optional()
        .map_err(err)
}

/// Fold lines read most-copies-first into [`MAX_LINES`] and a count of the rest.
fn bounded(mut lines: Vec<Line>) -> (Vec<Line>, usize, i64) {
    let total = lines.iter().map(|l| l.quantity).sum();
    let more = lines.len().saturating_sub(MAX_LINES);
    lines.truncate(MAX_LINES);
    (lines, more, total)
}

/// **`/collection search card:<name>`** — every copy of the card the collection holds, by
/// printing, finish and folder. `None` when the collection holds none (a row taken down to
/// zero copies is not holding one).
pub fn collection_by_name(conn: &Connection, name: &str) -> Result<Option<Holding>, String> {
    let candidates = "SELECT c.name AS name FROM collection_entries e
                        JOIN cards c ON c.id = e.card_id WHERE e.quantity > 0";
    let Some(found) = resolve(conn, candidates, name)? else {
        return Ok(None);
    };
    let sql = format!(
        "{COLLECTION_PATHS}
         SELECT sum(e.quantity), c.set_name, c.set_code, c.collector_number, e.finish, p.path,
                {price}
           FROM collection_entries e
           JOIN cards c ON c.id = e.card_id
           LEFT JOIN paths p ON p.id = e.folder_id
          WHERE c.name = ?1 AND e.quantity > 0
          GROUP BY c.id, e.finish, e.folder_id
          ORDER BY sum(e.quantity) DESC, c.set_name, c.collector_number, e.finish, p.path",
        price = price_in("e.finish")
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let lines: Vec<Line> = stmt
        .query_map([&found], |r| {
            Ok(Line {
                quantity: r.get(0)?,
                set_name: r.get(1)?,
                set_code: r.get(2)?,
                collector_number: r.get(3)?,
                finish: r.get(4)?,
                folder: r.get(5)?,
                price_usd: r.get(6)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<_>>()
        .map_err(err)?;
    let (image, type_line) = card_face(
        conn,
        "SELECT c.* FROM collection_entries e JOIN cards c ON c.id = e.card_id
          WHERE c.name = ?1 AND e.quantity > 0
          ORDER BY e.quantity DESC, c.released_at DESC",
        &found,
    )?;
    let (lines, more, total) = bounded(lines);
    Ok(Some(Holding {
        name: found,
        image,
        type_line,
        total,
        lines,
        more,
    }))
}

/// The image and type line of the rows `rows` answers for `name` (`rows` selects `c.*`).
fn card_face(
    conn: &Connection,
    rows: &str,
    name: &str,
) -> Result<(Option<String>, Option<String>), String> {
    // The first row with a picture, else the first row: a printing held in more copies with no
    // picture yet (the corpus fills over several alarms) must not hide one that has one.
    let sql = format!(
        "SELECT image, type_line FROM (
             SELECT {IMAGE_OF} AS image, c.type_line AS type_line, row_number() OVER () AS n
               FROM ({rows}) c)
          ORDER BY image IS NULL, n LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, [name], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(err)?
        .unwrap_or((None, None)))
}

/// **`/wishlist search card:<name>`** — every wish for the card: a printing and finish where the
/// wish names one, and the folder it is filed in.
pub fn wishlist_by_name(conn: &Connection, name: &str) -> Result<Option<Holding>, String> {
    let Some(found) = resolve(conn, "SELECT name FROM wishlist_entries", name)? else {
        return Ok(None);
    };
    let sql = format!(
        "{WISHLIST_PATHS}
         SELECT sum(w.quantity),
                coalesce(c.set_name, CASE WHEN w.card_id IS NULL THEN NULL ELSE upper(w.set_code) END),
                coalesce(c.set_code, w.set_code), coalesce(c.collector_number, w.collector_number),
                w.preferred_finish, p.path, CASE WHEN c.id IS NULL THEN NULL ELSE {price} END
           FROM wishlist_entries w
           LEFT JOIN cards c ON c.id = w.card_id
           LEFT JOIN paths p ON p.id = w.folder_id
          WHERE w.name = ?1
          GROUP BY w.card_id, w.preferred_finish, w.folder_id
          ORDER BY sum(w.quantity) DESC, w.card_id IS NULL, c.set_name, w.preferred_finish, p.path",
        price = price_in("w.preferred_finish")
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let lines: Vec<Line> = stmt
        .query_map([&found], |r| {
            Ok(Line {
                quantity: r.get(0)?,
                set_name: r.get(1)?,
                set_code: r.get(2)?,
                collector_number: r.get(3)?,
                finish: r.get(4)?,
                folder: r.get(5)?,
                price_usd: r.get(6)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<_>>()
        .map_err(err)?;
    // A printing the wish names first; else any printing of the name the corpus holds — what a
    // wish for any printing was filled with ([`crate::corpus`] asks Scryfall by name for it).
    let (image, type_line) = card_face(
        conn,
        "SELECT c.* FROM wishlist_entries w JOIN cards c ON c.id = w.card_id WHERE w.name = ?1
         UNION ALL
         SELECT c.* FROM cards c WHERE c.name = ?1",
        &found,
    )?;
    let (lines, more, total) = bounded(lines);
    Ok(Some(Holding {
        name: found,
        image,
        type_line,
        total,
        lines,
        more,
    }))
}

/// Which list an autocomplete is asking about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Collection,
    Wishlist,
    Deck,
}

impl Kind {
    pub fn parse(text: &str) -> Option<Kind> {
        match text {
            "collection" => Some(Kind::Collection),
            "wishlist" => Some(Kind::Wishlist),
            "deck" => Some(Kind::Deck),
            _ => None,
        }
    }
}

/// **An autocomplete's choices**: the names in `kind` that hold `prefix` anywhere, those that
/// begin with it first, at most `limit` (and never more than [`MAX_NAMES`]). A card's value is
/// its name; a deck's is its uid, so two decks of one name are two choices that stay apart.
/// Every name and value is clipped to [`MAX_CHOICE_CHARS`].
pub fn names(
    conn: &Connection,
    kind: Kind,
    prefix: &str,
    limit: usize,
) -> Result<Vec<Choice>, String> {
    let limit = limit.clamp(1, MAX_NAMES);
    let source = match kind {
        Kind::Collection => {
            "SELECT DISTINCT c.name AS name, c.name AS value FROM collection_entries e
               JOIN cards c ON c.id = e.card_id WHERE e.quantity > 0"
        }
        Kind::Wishlist => "SELECT DISTINCT name, name AS value FROM wishlist_entries",
        Kind::Deck => {
            "SELECT name, coalesce(sync_uid, 'id:' || id) AS value FROM decks WHERE archived = 0"
        }
    };
    let sql = format!(
        "SELECT name, value FROM ({source})
          WHERE instr(lower(name), lower(?1)) > 0
          ORDER BY instr(lower(name), lower(?1)) <> 1, name COLLATE NOCASE, value
          LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params![prefix.trim(), limit as i64], |r| {
            Ok(Choice {
                name: clip(&r.get::<_, String>(0)?, MAX_CHOICE_CHARS),
                value: clip(&r.get::<_, String>(1)?, MAX_CHOICE_CHARS),
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    Ok(rows)
}

/// **An add's `folder` completion** (the Discord spec, §14.4): the collection's `kind = 'user'`
/// folders whose path holds `prefix` anywhere, those that begin with it first, at most `limit`
/// (never more than [`MAX_NAMES`]). The name is the folder's path (`Binder/Artifacts`) and the
/// value its `sync_uid` — the one name of a folder every device of the group shares, and what
/// `integration::add::CollectionAdd::folder_uid` is. A folder with no uid yet is no choice.
///
/// A deck's folder and the removed-cards folder are never offered: a bot's add to either is
/// refused by every receiver (§14.2), so offering one would be offering a refusal.
pub fn folders(conn: &Connection, prefix: &str, limit: usize) -> Result<Vec<Choice>, String> {
    let limit = limit.clamp(1, MAX_NAMES);
    let sql = format!(
        "{COLLECTION_PATHS}
         SELECT p.path, f.sync_uid
           FROM collection_folders f JOIN paths p ON p.id = f.id
          WHERE f.kind = 'user' AND f.sync_uid IS NOT NULL
            AND instr(lower(p.path), lower(?1)) > 0
          ORDER BY instr(lower(p.path), lower(?1)) <> 1, p.path COLLATE NOCASE, f.sync_uid
          LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params![prefix.trim(), limit as i64], |r| {
            Ok(Choice {
                name: clip(&r.get::<_, String>(0)?, MAX_CHOICE_CHARS),
                value: r.get::<_, String>(1)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    Ok(rows)
}

/// A collection folder an add names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub uid: String,
    /// `Binder/Artifacts`, root first.
    pub path: String,
    /// `user`, `deck` or `removed`.
    pub kind: String,
}

/// **The collection folder `uid_or_path` names**: its `sync_uid` (what the completion handed
/// out), or — typed by hand — its path or its own name, the same any case, a user folder first.
/// `None` when no folder with a uid is either.
pub fn folder(conn: &Connection, uid_or_path: &str) -> Result<Option<Folder>, String> {
    let wanted = uid_or_path.trim();
    if wanted.is_empty() {
        return Ok(None);
    }
    let sql = format!(
        "{COLLECTION_PATHS}
         SELECT f.sync_uid, p.path, f.kind
           FROM collection_folders f JOIN paths p ON p.id = f.id
          WHERE f.sync_uid IS NOT NULL
            AND (f.sync_uid = ?1 OR p.path = ?1 COLLATE NOCASE OR f.name = ?1 COLLATE NOCASE)
          ORDER BY f.sync_uid = ?1 DESC, f.kind = 'user' DESC, p.path = ?1 COLLATE NOCASE DESC,
                   f.created_at, f.id
          LIMIT 1"
    );
    conn.query_row(&sql, [wanted], |r| {
        Ok(Folder {
            uid: r.get(0)?,
            path: r.get(1)?,
            kind: r.get(2)?,
        })
    })
    .optional()
    .map_err(err)
}

const DECK_SUMMARY: &str = "SELECT coalesce(d.sync_uid, 'id:' || d.id), d.name, d.format_key,
        coalesce((SELECT sum(quantity) FROM deck_cards dc
                   WHERE dc.deck_id = d.id AND dc.variant = 'live'), 0)
   FROM decks d";

fn summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckSummary> {
    Ok(DeckSummary {
        uid: r.get(0)?,
        name: r.get(1)?,
        format: r.get(2)?,
        cards: r.get(3)?,
    })
}

/// **The decks whose name holds `prefix`**, unarchived, by name — at most [`MAX_NAMES`].
pub fn decks(conn: &Connection, prefix: &str) -> Result<Vec<DeckSummary>, String> {
    let sql = format!(
        "{DECK_SUMMARY} WHERE d.archived = 0 AND instr(lower(d.name), lower(?1)) > 0
          ORDER BY instr(lower(d.name), lower(?1)) <> 1, d.name COLLATE NOCASE LIMIT {MAX_NAMES}"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map([prefix.trim()], summary)
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    Ok(rows)
}

/// The deck a `/deck` option names: its uid (what the autocomplete handed out), or — typed by
/// hand — a name, the same any case first.
fn deck_by(conn: &Connection, uid_or_name: &str) -> Result<Option<(i64, DeckSummary)>, String> {
    let sql = format!(
        "SELECT d.id, s.* FROM ({DECK_SUMMARY_WITH_ID}) s JOIN decks d ON d.id = s.id
          WHERE s.uid = ?1 OR (d.archived = 0 AND d.name = ?1 COLLATE NOCASE)
          ORDER BY s.uid = ?1 DESC, d.name = ?1 DESC, d.updated_at DESC LIMIT 1"
    );
    conn.query_row(&sql, [uid_or_name.trim()], |r| {
        Ok((
            r.get(0)?,
            DeckSummary {
                uid: r.get(2)?,
                name: r.get(3)?,
                format: r.get(4)?,
                cards: r.get(5)?,
            },
        ))
    })
    .optional()
    .map_err(err)
}

const DECK_SUMMARY_WITH_ID: &str = "SELECT d.id AS id, coalesce(d.sync_uid, 'id:' || d.id) AS uid,
        d.name AS name, d.format_key AS format,
        coalesce((SELECT sum(quantity) FROM deck_cards dc
                   WHERE dc.deck_id = d.id AND dc.variant = 'live'), 0) AS cards
   FROM decks d";

/// **`/deck deck:<uid>`** — the live list as transfer cards, in pile order. `None` when no deck
/// is that uid (or, typed, that name).
pub fn deck_cards(conn: &Connection, uid_or_name: &str) -> Result<Option<DeckList>, String> {
    let Some((id, deck)) = deck_by(conn, uid_or_name)? else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT dc.name, sum(dc.quantity), dc.set_code, dc.collector_number, dc.finish, dc.lang,
                cat.name, cat.kind, cat.is_active, l.name, l.color,
                c.set_name, c.rarity, c.type_line, {price}, c.legalities
           FROM deck_cards dc
           JOIN deck_categories cat ON cat.id = dc.category_id
           LEFT JOIN deck_labels l ON l.id = dc.label_id
           LEFT JOIN cards c ON c.id = dc.card_id
          WHERE dc.deck_id = ?1 AND dc.variant = 'live'
          GROUP BY dc.card_id, dc.finish, dc.category_id, dc.label_id
          ORDER BY cat.sort_order, cat.id, dc.name COLLATE NOCASE, dc.set_code, dc.collector_number",
        price = price_in("dc.finish")
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let cards = stmt
        .query_map([id], |r| {
            Ok(TransferCard {
                name: r.get(0)?,
                quantity: r.get(1)?,
                set_code: r.get(2)?,
                collector_number: r.get(3)?,
                finish: r.get(4)?,
                lang: r.get(5)?,
                category_name: r.get(6)?,
                category_kind: r.get(7)?,
                category_active: r.get(8)?,
                condition: None,
                tradelist_quantity: None,
                purchase_price: None,
                purchase_currency: None,
                acquired_at: None,
                acquisition_source: None,
                serial_number: None,
                grading: None,
                altered: None,
                signed: None,
                proxy: None,
                misprint: None,
                tags: None,
                notes: None,
                label_name: r.get(9)?,
                label_color: r.get(10)?,
                set_name: r.get(11)?,
                rarity: r.get(12)?,
                type_line: r.get(13)?,
                unit_price: r.get(14)?,
                legalities: r.get(15)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    Ok(Some(DeckList { deck, cards }))
}

#[cfg(test)]
mod tests;
