//! Importing a decklist: the one question TypeScript cannot answer.
//!
//! A reader pastes a list; [`crate::deck_import`]'s TypeScript half parses it into lines and
//! decides everything a *deck* decision is — which pile a card lands in, which card is the
//! commander, what the format is. What it cannot decide is **which printing in this app's
//! corpus a name means**, because that is a question about 116 k rows of data. So this module
//! answers exactly that and nothing else, one line at a time.
//!
//! Shaped like [`crate::card`] and [`crate::search`]: pure functions over a `Connection`,
//! testable without a Tauri app, wrapped in an `async` command that runs on the blocking pool
//! against the **read-only** connection. [`resolve_lines`] writes nothing at all.
//!
//! Three rules run through the whole file:
//!
//! * **A printing you own wins.** Somebody importing a list they already own copies for wants
//!   their copies in the deck, not a printing the app picked because it is newer. Only then
//!   does the newest printing win, and only then the id.
//! * **The `id` tie-break is a requirement, not decoration.** Two printings released on the
//!   same day are ordinary in this corpus, and without a total order the same list pasted
//!   twice would build two different decks. [`MATCH_ORDER`] is the whole of that promise, and
//!   the fold arm re-implements it in Rust rather than being allowed to disagree with it.
//! * **Failing open beats failing loud.** A name this app has never heard of is
//!   `matched: None` — a line the preview quotes and the import proceeds without — and so is a
//!   line whose SQL failed. [`resolve_lines`] answers `Err` only when a statement cannot be
//!   *prepared*, which is a broken schema rather than a broken decklist.
//!
//! Nothing here reads `raw`: every fact an import needs has had a column since schema v5, and
//! `raw` is a gzip BLOB that `json_extract` refuses (CLAUDE.md).

use crate::sync::{lock_db_read, AppState};
use rusqlite::{params, Connection, OptionalExtension, Params, Row, Statement};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The largest decklist file this app will read, in bytes.
///
/// A megabyte is roughly 25 000 lines — two orders of magnitude past any real decklist, and
/// small enough that reading it into memory to parse it is never a question. It lives here
/// rather than beside the file-reading command because the limit is a fact about *imports*,
/// and the paste path and the file path must not be able to disagree about it.
pub const MAX_IMPORT_BYTES: u64 = 1024 * 1024;

/// What an import may do to the deck it lands in: fold into what is there, or replace it.
///
/// A `[&str; 2]` and not an enum for [`crate::schema::DECK_VARIANTS`]'s reason — it is
/// validated at the one command that takes it, and a list is what a refusal quotes back.
pub const IMPORT_MODES: [&str; 2] = ["merge", "replace"];

/// A card name reduced to what two people typing it would agree on: lowercase, no diacritics,
/// one kind of apostrophe, single spaces.
///
/// Hand-written rather than `unicode-normalization`, because the alphabet a Magic card name
/// can be printed in is small and known, and a dependency added for one function is a
/// dependency to keep. Anything not on the table passes through, so a name in a script this
/// table has never heard of folds to itself and still matches itself exactly.
pub fn fold_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => {
                out.push('a')
            }
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => out.push('e'),
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => out.push('i'),
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' => {
                out.push('o')
            }
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => out.push('u'),
            'ñ' | 'Ñ' => out.push('n'),
            'ç' | 'Ç' => out.push('c'),
            'ý' | 'ÿ' | 'Ý' => out.push('y'),
            'æ' | 'Æ' => out.push_str("ae"),
            'œ' | 'Œ' => out.push_str("oe"),
            'ß' => out.push_str("ss"),
            '\u{2019}' | '\u{02BC}' | '`' => out.push('\''),
            '\u{2013}' | '\u{2014}' => out.push('-'),
            _ => out.extend(ch.to_lowercase()),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One line of a parsed decklist, as TypeScript hands it over.
///
/// The quantity is deliberately not here: this command answers *which printing*, and how many
/// of it the list asked for is the caller's arithmetic. Both hints are optional because most
/// decklist formats carry neither.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLine {
    pub name: String,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
}

/// The printing a line resolved to, and every fact the preview and the validation engine
/// need about it.
///
/// The card columns are `DECK_CARD_SELECT`'s card half verbatim, so an imported card and a
/// card already in a deck are described by the same facts — a preview that judged legality on
/// a narrower set of columns than the editor would report a legal deck that the editor then
/// refuses. Two fields are the import's own: [`Self::owned_quantity`], because "you already
/// own this" is the reason a printing was chosen, and [`Self::printing_count`], so the preview
/// can say how many printings the reader is choosing between.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMatch {
    pub card_id: String,
    /// **The whole printed name**, so a double-faced card resolved from its front face comes
    /// back as `"A // B"` — what `deck_cards.name` denormalises and what the reader is shown.
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    pub oracle_id: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub colors: Option<String>,
    pub color_identity: Option<String>,
    /// **This printing's** blob, which is what makes `oldschool` come out right with no
    /// special case — see `DeckCardRow::legalities`.
    pub legalities: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub layout: Option<String>,
    pub rarity: Option<String>,
    pub faces: Option<String>,
    /// `cards.game_changer` is nullable, and a NULL means *not on the list* — the column is
    /// only ever set for the cards Wizards named. So it is read as an `Option` and flattened
    /// here rather than being handed to TypeScript as a third state it would have to fence.
    pub game_changer: bool,
    pub ever_uncommon: bool,
    /// The nonfoil `usd` key of this printing's `prices` blob. Never `cards.price_usd`, which
    /// is a display fallback chain and must not be summed (CLAUDE.md).
    pub unit_price_usd: Option<f64>,
    /// Every copy of *this printing* the collection holds, finish-blind. Not the deck's
    /// allocation — nothing has been allocated yet — and it is here because it is the reason
    /// this printing won.
    pub owned_quantity: i64,
    /// How many **paper** printings of this card the corpus has, so the preview can offer the
    /// reader a choice without a second query per line.
    pub printing_count: i64,
}

/// What one line of the list resolved to.
///
/// [`Self::index`] rides along because the answer is per line and the caller's list is the
/// only thing that knows what line 34 said. It is the caller's index, not a row number: the
/// two are the same today and a filter between them would make them differ silently.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResolveRow {
    pub index: usize,
    pub matched: Option<ImportMatch>,
    /// The line carried a set (and perhaps a collector number) that names no printing this
    /// app has. **It is not a failure** — the name rules ran anyway, so `matched` is usually
    /// `Some` beside it — but the preview says so, because the reader asked for a specific
    /// printing and got a different one.
    pub hint_missed: bool,
}

/// The card half of `DECK_CARD_SELECT`, plus the two facts only an import asks for.
///
/// **Copied from `deck.rs`'s `DECK_CARD_SELECT` rather than retyped**, so an import and the
/// editor cannot come to describe a card differently. Three deliberate differences, named here
/// so a reader diffing the two does not have to guess which are drift: `c.finishes` is absent
/// (a deck names a printing and never a finish — the column exists for the editor's foil
/// marking, which no preview draws), `owned_quantity` and `printing_count` are added, and
/// `ever_uncommon`/`unit_price_usd` swap places to match [`ImportMatch`]'s field order.
///
/// `count(*) OVER ()` is computed before `LIMIT` — measured 2026-08-12 through `node:sqlite`
/// over a four-row fixture: `SELECT id, count(*) OVER () FROM cards WHERE name='Sol Ring'
/// ORDER BY … LIMIT 1` answered one row carrying `n = 3`. So it counts every printing that
/// matched rather than the one that won, which is what the preview needs to say "4 printings".
///
/// It stops short of `FROM` because two different `FROM`s read it: the three SQL arms scan
/// `cards`, and the fold arm reaches the same columns through `cards_fts`. One column list,
/// two shapes — the alternative is two column lists, which is the drift this constant exists
/// to prevent.
const MATCH_COLUMNS: &str = "SELECT c.id, c.name, c.set_code, c.collector_number, c.lang,
        c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
        c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
        c.faces, c.game_changer,
        EXISTS(SELECT 1 FROM cards u
                WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon,
        CAST(json_extract(c.prices, '$.usd') AS REAL) AS unit_price_usd,
        coalesce((SELECT sum(e.quantity) FROM collection_entries e
                   WHERE e.card_id = c.id), 0) AS owned_quantity,
        count(*) OVER () AS printing_count";

/// The three SQL arms' source.
const FROM_CARDS: &str = "\n   FROM cards c";

/// The order every arm below shares: a printing you own, then the newest, then the id.
///
/// The `id` tie-break is not decoration — it is what makes an import **deterministic**, so
/// the same list pasted twice puts the same printings in the deck.
const MATCH_ORDER: &str =
    " ORDER BY owned_quantity DESC, coalesce(c.released_at, '0000-00-00') DESC, c.id DESC LIMIT 1";

/// The printing hint at full strength: a set code and a collector number name one printing,
/// and the reader who wrote them down meant them. No name is consulted at all, so a list whose
/// names are in another language still lands on the right cards.
const BY_SET_AND_NUMBER: &str = " WHERE c.is_paper = 1
      AND c.set_code = ?1 COLLATE NOCASE
      AND c.collector_number = ?2 COLLATE NOCASE";

/// The name arm. **Both halves of a double-faced name match**: `cards.name` carries
/// `"A // B"`, and a list naming only the front is the commonest way a DFC is written down.
/// `instr` answers 0 for a single-faced name, so `substr(name, 1, -1)` is `''` and never
/// equals a real name.
///
/// **`''` is not a real name, and that is load-bearing rather than obvious.** Measured
/// 2026-08-12: `substr(name, 1, instr(name, ' // ') - 1) = ''` is *true* of every single-faced
/// row, so an empty query name would resolve to an arbitrary card. [`resolve_lines`] never
/// reaches this statement with one — that guard is the fence, not this comment.
const BY_NAME: &str = " WHERE c.is_paper = 1
      AND (c.name = ?1 COLLATE NOCASE
           OR substr(c.name, 1, instr(c.name, ' // ') - 1) = ?1 COLLATE NOCASE)";

/// The half-hint arm: a set with no collector number beside it, which is what most exports
/// that carry a set at all write. [`BY_NAME`]'s clause on `?2`, narrowed to one set.
const BY_SET_AND_NAME: &str = " WHERE c.is_paper = 1
      AND c.set_code = ?1 COLLATE NOCASE
      AND (c.name = ?2 COLLATE NOCASE
           OR substr(c.name, 1, instr(c.name, ' // ') - 1) = ?2 COLLATE NOCASE)";

/// The fold arm's one extra column. [`MATCH_COLUMNS`] carries no `released_at` — the SQL arms
/// order by it without selecting it — and the fold arm orders in Rust, so it has to be handed
/// the key it orders on.
const FTS_RELEASED: &str = ", coalesce(c.released_at, '0000-00-00') AS released";

/// The fold arm's source and window.
///
/// `cards_fts` narrows the candidate set so the fold never scans the corpus. The cap is
/// deliberate and its cost is named: a phrase that appears in the indexed text of more than
/// 200 paper cards could have the printing the reader meant fall outside the window, and the
/// line then comes back unmatched. That is this module's failure mode everywhere else too —
/// a line the preview quotes — and the arm only runs at all when the exact name matched
/// nothing, so the candidate set is names that are *not* what was typed.
const FTS_FROM_AND_WHERE: &str = "\n   FROM cards_fts f JOIN cards c ON c.rowid = f.rowid
  WHERE cards_fts MATCH ?1 AND c.is_paper = 1 LIMIT 200";

/// One [`ImportMatch`] out of a row of [`MATCH_COLUMNS`].
fn read_match(r: &Row<'_>) -> rusqlite::Result<ImportMatch> {
    Ok(ImportMatch {
        card_id: r.get(0)?,
        name: r.get(1)?,
        set_code: r.get(2)?,
        collector_number: r.get(3)?,
        lang: r.get(4)?,
        oracle_id: r.get(5)?,
        mana_cost: r.get(6)?,
        cmc: r.get(7)?,
        type_line: r.get(8)?,
        oracle_text: r.get(9)?,
        colors: r.get(10)?,
        color_identity: r.get(11)?,
        legalities: r.get(12)?,
        power: r.get(13)?,
        toughness: r.get(14)?,
        layout: r.get(15)?,
        rarity: r.get(16)?,
        faces: r.get(17)?,
        game_changer: r.get::<_, Option<bool>>(18)?.unwrap_or(false),
        ever_uncommon: r.get(19)?,
        unit_price_usd: r.get(20)?,
        owned_quantity: r.get(21)?,
        printing_count: r.get(22)?,
    })
}

/// The winning row of one arm, or none — **and an error is none.**
///
/// A line whose SQL failed is a line the preview quotes as unmatched, never a request that
/// fails: 99 good lines must not be lost to one bad one. The only errors [`resolve_lines`]
/// raises are `prepare` failures, which are a broken schema rather than a broken decklist.
fn one(stmt: &mut Statement<'_>, p: impl Params) -> Option<ImportMatch> {
    stmt.query_row(p, read_match).optional().ok().flatten()
}

/// A hint the caller actually gave: trimmed, and absent when it is blank.
///
/// `Some("")` and `Some("   ")` reach here from real exports — a trailing tab in a Moxfield
/// paste is enough — and either would be bound into `c.set_code = ?1`, matching no set and so
/// turning every line into a missed hint.
fn given(hint: &Option<String>) -> Option<&str> {
    hint.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Does this card's name fold to what the reader typed — whole, or on its front face?
///
/// The Rust mirror of [`BY_NAME`]'s two clauses, and it has the same empty-string trap: a
/// single-faced name has no front half, so `wanted` being `""` would match everything. Its
/// one caller returns before this is ever reached with one.
fn folded_matches(card_name: &str, wanted: &str) -> bool {
    fold_name(card_name) == wanted
        || card_name
            .split_once(" // ")
            .is_some_and(|(front, _)| fold_name(front) == wanted)
}

/// The last arm: fold both sides and compare in Rust.
///
/// The comparison cannot be SQL — a fold is a 40-entry table, and SQLite's `lower()` is ASCII
/// and its `NOCASE` collation more so. So `cards_fts` picks the candidates and Rust judges
/// them, which is also why the ordering is repeated here by hand: this arm must reach the same
/// printing [`MATCH_ORDER`] would, or an import stops being deterministic at exactly the names
/// that needed the most help.
///
/// `printing_count` is recomputed as the number of candidates that *kept*, because the
/// `count(*) OVER ()` this arm's SQL carries counts everything FTS returned — the reader is
/// choosing between the printings of their card, not between everything that mentioned it.
fn fold_match(stmt: &mut Statement<'_>, name: &str) -> Option<ImportMatch> {
    let wanted = fold_name(name);
    if wanted.is_empty() {
        return None;
    }
    // The MATCH argument is a quoted phrase with its own quotes doubled — an unescaped name
    // containing a quote is an FTS syntax error, not a miss. Measured 2026-08-12: a bare
    // `"one " two"` answers `unterminated string`, and the doubled form answers rows.
    let phrase = format!("\"{}\"", name.replace('"', "\"\""));
    let mut kept: Vec<(ImportMatch, String)> = stmt
        .query_map(params![phrase], |r| Ok((read_match(r)?, r.get(23)?)))
        .ok()?
        .filter_map(Result::ok)
        .filter(|(m, _)| folded_matches(&m.name, &wanted))
        .collect();
    let count = i64::try_from(kept.len()).unwrap_or(i64::MAX);
    kept.sort_by(|a, b| {
        b.0.owned_quantity
            .cmp(&a.0.owned_quantity)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.0.card_id.cmp(&a.0.card_id))
    });
    let mut winner = kept.into_iter().next()?.0;
    winner.printing_count = count;
    Some(winner)
}

/// Every line of a parsed decklist, resolved to a printing this app has.
///
/// Four statements, prepared once and reused down the list, tried in the order the reader's
/// own intent runs out:
///
/// 1. **A set and a collector number** name one printing, and are taken at their word.
/// 2. **A set alone** narrows the name rule to that set.
/// 3. A hint that was present and named nothing sets `hint_missed` and **falls through** —
///    the reader wanting a printing this app has not got is not a reason to lose the card.
/// 4. **The name**, exactly, either whole or as the front face of a double-faced card.
/// 5. **The folded name**, through `cards_fts` — see [`fold_match`].
///
/// Only `prepare` can fail the call. Everything after it degrades to `matched: None`.
pub fn resolve_lines(
    conn: &Connection,
    lines: &[ResolveLine],
) -> Result<Vec<ImportResolveRow>, String> {
    let scan = format!("{MATCH_COLUMNS}{FROM_CARDS}");
    let prepare = |sql: &str| {
        conn.prepare(sql)
            .map_err(|e| format!("the decklist could not be resolved: {e}"))
    };
    let mut by_printing = prepare(&format!("{scan}{BY_SET_AND_NUMBER}{MATCH_ORDER}"))?;
    let mut by_set_and_name = prepare(&format!("{scan}{BY_SET_AND_NAME}{MATCH_ORDER}"))?;
    let mut by_name = prepare(&format!("{scan}{BY_NAME}{MATCH_ORDER}"))?;
    let mut by_fold = prepare(&format!(
        "{MATCH_COLUMNS}{FTS_RELEASED}{FTS_FROM_AND_WHERE}"
    ))?;

    let mut out = Vec::with_capacity(lines.len());
    for (index, l) in lines.iter().enumerate() {
        // Trimmed, and an empty name is no name at all: `BY_NAME`'s front-face clause matches
        // every single-faced card against `''` (measured — see that constant), so a blank line
        // that reached the name arms would resolve to an arbitrary printing rather than to
        // nothing. A hint needs no name and is still honoured.
        let name = l.name.trim();
        let mut matched = None;
        let mut hint_missed = false;
        if let Some(set) = given(&l.set_code) {
            matched = match given(&l.collector_number) {
                Some(number) => one(&mut by_printing, params![set, number]),
                None if !name.is_empty() => one(&mut by_set_and_name, params![set, name]),
                None => None,
            };
            hint_missed = matched.is_none();
        }
        if matched.is_none() && !name.is_empty() {
            matched = one(&mut by_name, params![name]).or_else(|| fold_match(&mut by_fold, name));
        }
        out.push(ImportResolveRow {
            index,
            matched,
            hint_missed,
        });
    }
    Ok(out)
}

/// Every name in a pasted decklist, resolved to a printing this app has. **Read-only.**
///
/// On the blocking pool against `db_read`, like every other read: a list of a few hundred
/// names is four prepared statements and a few hundred index lookups, which is small but not
/// free, and it must never queue behind an ingest.
#[tauri::command]
pub async fn deck_import_resolve(
    state: tauri::State<'_, Arc<AppState>>,
    lines: Vec<ResolveLine>,
) -> Result<Vec<ImportResolveRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || resolve_lines(&lock_db_read(&state), &lines))
        .await
        .map_err(|e| format!("the decklist could not be resolved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eight printings, shaped around the four questions this module has to answer.
    ///
    /// Four **paper** Sol Rings and one digital one, because every ordering rule needs more
    /// than one printing of a name to order and `printing_count` needs a digital printing to
    /// leave out. `40k` and `clb` are given the **same** `released_at` deliberately — the real
    /// corpus is full of sets that share a release date, and without a tie the `id` tie-break
    /// that makes an import deterministic has nothing to break.
    ///
    /// The other three are one each: a double-faced card written the way a decklist writes it
    /// (front face only), a name with a diacritic in it, and an Arena-only card whose *only*
    /// printing is digital.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,released_at,
                    is_paper,layout,rarity,mana_cost,cmc,type_line,oracle_text,colors,
                    color_identity,legalities,power,toughness,prices,raw)
               VALUES
                 ('sol-lea','o-sol','Sol Ring','lea','264','en','1993-08-05',1,'normal',
                  'uncommon','{1}',1.0,'Artifact','{T}: Add {C}{C}.','','',
                  '{"vintage":"restricted","commander":"legal"}',NULL,NULL,
                  '{"usd":"3500.00"}','{}'),
                 ('sol-c21','o-sol','Sol Ring','c21','263','en','2021-04-23',1,'normal',
                  'uncommon','{1}',1.0,'Artifact','{T}: Add {C}{C}.','','',
                  '{"vintage":"restricted","commander":"legal"}',NULL,NULL,
                  '{"usd":"2.00"}','{}'),
                 ('sol-40k','o-sol','Sol Ring','40k','171','en','2022-10-07',1,'normal',
                  'uncommon','{1}',1.0,'Artifact','{T}: Add {C}{C}.','','',
                  '{"vintage":"restricted","commander":"legal"}',NULL,NULL,
                  '{"usd":"2.50"}','{}'),
                 ('sol-clb','o-sol','Sol Ring','clb','322','en','2022-10-07',1,'normal',
                  'uncommon','{1}',1.0,'Artifact','{T}: Add {C}{C}.','','',
                  '{"vintage":"restricted","commander":"legal"}',NULL,NULL,
                  '{"usd":"1.75"}','{}'),
                 ('sol-ana','o-sol','Sol Ring','ana','1','en','2021-01-01',0,'normal',
                  'uncommon','{1}',1.0,'Artifact','{T}: Add {C}{C}.','','',
                  '{"vintage":"restricted","commander":"legal"}',NULL,NULL,NULL,'{}'),
                 ('kolvori','o-kol','Kolvori, God of Kinship // The Ringhart Crest','khm','216',
                  'en','2021-02-05',1,'modal_dfc','rare','{1}{G}{G}',3.0,
                  'Legendary Creature — God','Vigilance, trample','G','G',
                  '{"commander":"legal"}','2','4','{"usd":"4.00"}','{}'),
                 ('jotun','o-jot','Jötun Grunt','csp','8','en','2006-07-21',1,'normal',
                  'uncommon','{1}{W}',2.0,'Creature — Giant Soldier',
                  'Cumulative upkeep','W','W','{"legacy":"legal"}','4','4',
                  '{"usd":"0.60"}','{}'),
                 ('archive','o-arc','Key to the Archive','ha3','1','en','2021-12-09',0,'normal',
                  'rare','{3}',3.0,'Artifact','Draw a card.','','',
                  '{"historic":"legal"}',NULL,NULL,NULL,'{}');"#,
        )
        .unwrap();
        // `cards_fts` is external-content with no triggers, and the fold arm reads through it
        // (CLAUDE.md: any write to `cards` outside the ingest path that touches an indexed
        // column owes a rebuild). Without this line `a_folded_name_matches_when_the_exact_one
        // _does_not` fails against an index that has never heard of these rows.
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn
    }

    /// A line with no printing hint on it — what most of a pasted decklist looks like.
    fn line(name: &str) -> ResolveLine {
        ResolveLine {
            name: name.to_owned(),
            set_code: None,
            collector_number: None,
        }
    }

    /// A line carrying a set, and optionally a collector number.
    fn hinted(name: &str, set_code: &str, collector_number: Option<&str>) -> ResolveLine {
        ResolveLine {
            name: name.to_owned(),
            set_code: Some(set_code.to_owned()),
            collector_number: collector_number.map(str::to_owned),
        }
    }

    /// The one row a one-line list resolves to.
    fn resolve_one(conn: &Connection, l: ResolveLine) -> ImportResolveRow {
        let mut rows = resolve_lines(conn, &[l]).unwrap();
        assert_eq!(rows.len(), 1, "one line in, one row out");
        rows.pop().unwrap()
    }

    /// The printing a one-line list landed on. Panics rather than returning an `Option`: a
    /// test that means "this matched" should say so at the line that asserts it.
    fn matched_id(conn: &Connection, l: ResolveLine) -> String {
        let name = l.name.clone();
        resolve_one(conn, l)
            .matched
            .unwrap_or_else(|| panic!("`{name}` resolved to nothing"))
            .card_id
    }

    /// One collection row, at the plainest grain there is — [`crate::deck`]'s test helper.
    fn own(conn: &Connection, card_id: &str, quantity: i64) {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn a_name_folds_to_something_a_reader_could_have_typed() {
        assert_eq!(fold_name("Jötun Grunt"), "jotun grunt");
        assert_eq!(fold_name("Márton Stromgald"), "marton stromgald");
        assert_eq!(fold_name("Ach! Hans, Run!"), "ach! hans, run!");
        assert_eq!(fold_name("Yawgmoth’s Will"), "yawgmoth's will");
        assert_eq!(fold_name("  Sol   Ring "), "sol ring");
        assert_eq!(fold_name("Æther Vial"), "aether vial");
    }

    #[test]
    fn an_exact_name_resolves_to_one_printing() {
        let conn = seeded();
        let row = resolve_one(&conn, line("Sol Ring"));
        let m = row.matched.expect("Sol Ring is in the corpus");
        assert_eq!(row.index, 0);
        assert!(!row.hint_missed, "no hint was given, so none was missed");
        assert_eq!(m.name, "Sol Ring");
        assert_eq!(m.lang, "en");
        assert_eq!(m.oracle_id.as_deref(), Some("o-sol"));
        assert_eq!(m.cmc, Some(1.0));
        assert!(m.ever_uncommon, "Sol Ring has been printed at uncommon");
    }

    #[test]
    fn a_front_face_name_matches_a_double_faced_card() {
        let conn = seeded();
        assert_eq!(
            matched_id(&conn, line("Kolvori, God of Kinship")),
            "kolvori"
        );
    }

    #[test]
    fn a_printing_you_own_beats_a_newer_one_you_do_not() {
        let conn = seeded();
        own(&conn, "sol-lea", 1);
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.card_id, "sol-lea",
            "the 1993 printing, because it is owned"
        );
        assert_eq!(m.owned_quantity, 1);
    }

    #[test]
    fn with_nothing_owned_the_newest_paper_printing_wins() {
        let conn = seeded();
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.card_id, "sol-clb",
            "2022-10-07, and `clb` > `40k` on the id"
        );
        assert_eq!(m.owned_quantity, 0);
    }

    #[test]
    fn a_digital_only_printing_is_never_returned() {
        let conn = seeded();
        let row = resolve_one(&conn, line("Key to the Archive"));
        assert!(row.matched.is_none(), "its only printing is Arena's");
    }

    #[test]
    fn a_set_and_collector_hint_wins_over_both_rules() {
        let conn = seeded();
        own(&conn, "sol-lea", 4);
        let row = resolve_one(&conn, hinted("Sol Ring", "c21", Some("263")));
        assert!(!row.hint_missed);
        assert_eq!(
            row.matched.unwrap().card_id,
            "sol-c21",
            "neither the owned printing nor the newest one"
        );
    }

    #[test]
    fn a_hint_that_names_nothing_falls_through_and_says_so() {
        let conn = seeded();
        let row = resolve_one(&conn, hinted("Sol Ring", "zzz", Some("999")));
        assert!(
            row.hint_missed,
            "the hint named a printing this app has not got"
        );
        assert_eq!(
            row.matched.unwrap().card_id,
            "sol-clb",
            "and the name rule answered anyway"
        );
    }

    #[test]
    fn a_folded_name_matches_when_the_exact_one_does_not() {
        let conn = seeded();
        assert_eq!(matched_id(&conn, line("Jotun Grunt")), "jotun");
    }

    #[test]
    fn an_unmatched_name_is_a_row_with_no_match_and_not_an_error() {
        let conn = seeded();
        let rows = resolve_lines(&conn, &[line("Definitely Not A Magic Card")])
            .expect("an unmatched name is a row, never an `Err`");
        assert!(rows[0].matched.is_none());
        assert!(!rows[0].hint_missed);
    }

    /// The trap [`BY_NAME`]'s doc records, pinned rather than trusted. `substr(name, 1,
    /// instr(name, ' // ') - 1)` is `''` for every single-faced card and `'' = ''` is **true**,
    /// so a blank name reaching the name arm would resolve to whichever printing the ordering
    /// happened to put first — a wrong answer wearing a right one's clothes. Not in the brief's
    /// list of twelve; it is here because the measurement that found it is what put the guard
    /// in [`resolve_lines`], and an unpinned guard is a guard somebody deletes.
    #[test]
    fn a_blank_name_resolves_to_nothing_rather_than_to_whatever_sorts_first() {
        let conn = seeded();
        assert!(resolve_one(&conn, line("   ")).matched.is_none());
        assert!(resolve_one(&conn, line("")).matched.is_none());
        let would_have: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards WHERE substr(name, 1, instr(name, ' // ') - 1) = ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            would_have, 7,
            "the clause the guard fences off matches every single-faced row in the fixture"
        );
    }

    #[test]
    fn the_same_list_twice_resolves_to_the_same_ids() {
        let conn = seeded();
        let list = [
            line("Sol Ring"),
            line("Kolvori, God of Kinship"),
            line("Jotun Grunt"),
            hinted("Sol Ring", "40k", None),
        ];
        let first = resolve_lines(&conn, &list).unwrap();
        let second = resolve_lines(&conn, &list).unwrap();
        let ids = |rows: &[ImportResolveRow]| -> Vec<Option<String>> {
            rows.iter()
                .map(|r| r.matched.as_ref().map(|m| m.card_id.clone()))
                .collect()
        };
        assert_eq!(ids(&first), ids(&second));
        assert_eq!(
            ids(&first),
            vec![
                Some("sol-clb".to_owned()),
                Some("kolvori".to_owned()),
                Some("jotun".to_owned()),
                Some("sol-40k".to_owned()),
            ],
            "`clb` and `40k` share a release date, so the id decides — and it decides the \
             same way both times"
        );
    }

    #[test]
    fn printing_count_is_the_number_of_paper_printings_of_that_name() {
        let conn = seeded();
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.printing_count, 4,
            "four paper printings, and Arena's is not one"
        );
    }
}
