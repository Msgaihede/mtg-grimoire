//! Importing a decklist: the one question TypeScript cannot answer.
//!
//! A reader pastes a list; the TypeScript half (`src/features/decks/import/`, mirrored across
//! IPC by `src/lib/ipc.ts`) parses it into lines and
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
//! # Every arm is one indexed lookup, and `COLLATE NOCASE` is what stops it being one
//!
//! `cards.name`, `set_code` and `collector_number` are declared plain `TEXT`, so
//! `idx_cards_name` and `idx_cards_set_cn` are BINARY, and a comparison naming a different
//! collation cannot use them. Nor can an *expression* over a column, which is what
//! `substr(name, 1, instr(name, ' // ') - 1)` is. Measured 2026-08-12 with
//! `EXPLAIN QUERY PLAN` through `node:sqlite`, against a file copy of the live 116 695-row
//! database with its real index set:
//!
//! | predicate | plan |
//! |---|---|
//! | `c.name = ?1 COLLATE NOCASE` | `SCAN c` |
//! | `name = ?1 COLLATE NOCASE OR substr(name, …) = ?1 COLLATE NOCASE` | `SCAN c` |
//! | `set_code = ?1 COLLATE NOCASE AND collector_number = ?2 COLLATE NOCASE` | `SCAN c` |
//! | `c.name = ?1` | `SEARCH c USING INDEX idx_cards_name (name=?)` |
//! | `c.name >= ?1 AND c.name < ?2` | `SEARCH c USING INDEX idx_cards_name (name>? AND name<?)` |
//! | `set_code = ?1 AND collector_number = ?2` | `SEARCH c USING INDEX idx_cards_set_cn (set_code=? AND collector_number=?)` |
//! | `set_code = ?1 AND collector_number = ?2 COLLATE NOCASE` | `SEARCH c USING INDEX idx_cards_set_cn (set_code=?)` |
//!
//! A `SCAN` per line is CLAUDE.md's 397 ms full-table figure *per line*, and the cost is not
//! theoretical. Timed through [`resolve_lines`] itself on a **release** build over that same
//! corpus, a 105-line commander list taken out of the corpus, medians of nine:
//!
//! | list | now | with the first version's one `OR`/`NOCASE` arm |
//! |---|---|---|
//! | names as printed | **11.5 ms** | **46 123 ms** |
//! | the same list lower-cased | 31.6 ms | — |
//! | every line with an upper-cased `(SET) N` hint | 51.9 ms | — |
//!
//! The two columns differ in the `WHERE` clause and nothing else — the old one was rebuilt by
//! swapping that clause back into the shipped statement, same column list, same process, same
//! file. That is a **4 000×** difference, and it is the difference between a feature and a
//! hang; the plan's budget for this is "well under the 100 ms a preview can absorb".
//!
//! **Case-insensitivity is not lost — it moved to the fold arm**, which lowercases both sides
//! in Rust and reaches its candidates through `cards_fts`, whose tokenizer is already
//! case-insensitive and diacritic-folding. That is the 31.6 ms row above: all 105 lines still
//! resolve, to the same printings, with the whole list lower-cased. So a dropped
//! `COLLATE NOCASE` here reads like a regression and is not one; do not restore it.
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
    /// **How many rows the rule that matched this line found** — not how many printings the
    /// card has, which is a different number and one nothing here computes.
    ///
    /// It is per *arm*, and [`resolve_lines`] has **six**, so this field means six things:
    /// through a set-and-collector-number hint it is how many printings that pair named (1, in
    /// a corpus with no duplicates); through a set-scoped name it is that name's printings
    /// **within that set**, and through a set-scoped front face, that set's printings whose
    /// front face is that name; through a bare name it is that name's paper printings
    /// corpus-wide, and through a bare front face, the paper printings whose front face is
    /// that name; through the fold arm it is how many candidates survived the fold comparison.
    ///
    /// Stated this narrowly on purpose. Nothing consumes the field yet, and buying a per-line
    /// second query so that a "12 printings" affordance nobody has built could read a true
    /// per-name count is the wrong trade — the arms are one indexed lookup each precisely
    /// because they do not do that.
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
/// It stops short of `FROM` and of `printing_count` because two different tails read it: the
/// five SQL arms scan `cards` and count with a window function, and the fold arm reaches the
/// same columns through `cards_fts` and counts in Rust. One column list, two shapes — the
/// alternative is two column lists, which is the drift this constant exists to prevent.
const MATCH_COLUMNS: &str = "SELECT c.id, c.name, c.set_code, c.collector_number, c.lang,
        c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
        c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
        c.faces, c.game_changer,
        EXISTS(SELECT 1 FROM cards u
                WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon,
        CAST(json_extract(c.prices, '$.usd') AS REAL) AS unit_price_usd,
        coalesce((SELECT sum(e.quantity) FROM collection_entries e
                   WHERE e.card_id = c.id), 0) AS owned_quantity";

/// The five SQL arms' tail: their source, and the count only they compute.
const FROM_CARDS: &str = ",\n        count(*) OVER () AS printing_count\n   FROM cards c";

/// The order every arm shares: a printing you own, then the newest, then the id.
///
/// The `id` tie-break is not decoration — it is what makes an import **deterministic**, so
/// the same list pasted twice puts the same printings in the deck.
const MATCH_ORDER: &str =
    " ORDER BY owned_quantity DESC, coalesce(c.released_at, '0000-00-00') DESC, c.id DESC";

/// The printing hint at full strength: a set code and a collector number name one printing,
/// and the reader who wrote them down meant them. No name is consulted at all, so a list whose
/// names are in another language still lands on the right cards.
///
/// `set_code` is bound binary — [`resolve_lines`] lower-cases it first, and **0 of the corpus's
/// 116 695 rows carry a non-lowercase set code** (measured), so that is exactly the case the
/// rows hold. `collector_number` keeps `COLLATE NOCASE` and is the one place it survives,
/// because **7 083 rows carry an uppercase letter** (`8ed` `S1`, `S5a`, …) while **0 pairs in
/// one set differ only by case** — so folding it in Rust would be wrong in both directions and
/// case-insensitivity here is unambiguous. It stays indexed regardless: the set code alone
/// carries `idx_cards_set_cn`, measured as
/// `SEARCH c USING INDEX idx_cards_set_cn (set_code=?)`, which bounds the arm by the size of
/// one set — 5 120 rows for `plst`, the largest in the corpus, and a few hundred for a normal
/// one. 105 hinted lines cost **52.0 ms**.
const BY_SET_AND_NUMBER: &str = " WHERE c.is_paper = 1
      AND c.set_code = ?1
      AND c.collector_number = ?2 COLLATE NOCASE";

/// The name, exactly.
///
/// **This is a separate statement from [`BY_FRONT_FACE`] and the split is a correctness fix,
/// not a performance one.** The first version was one arm with an `OR`, which let
/// [`MATCH_ORDER`] choose between a real card and a `"N // X"` row — and Scryfall's art series
/// print exactly that, `"Dakkon, Shadow Slayer // Dakkon, Shadow Slayer"`, the trap CLAUDE.md
/// already records for the search's relevance ranking. Measured 2026-08-12 over the live
/// corpus: **51 names** have a `"N // X"` printing that outranks every real printing of `N`,
/// and **3 of 105** lines of the reference list resolved to an art-series row instead of the
/// card. `Dakkon` is the exact mechanism — `mh2` and `amh2` share a release date and the art
/// series wins the `id` tie-break.
///
/// Sequenced, the exact name always wins, because it is asked first and answers before the
/// front-face arm is reached. A `MULTI-INDEX OR` would be indexed (measured, it is) and still
/// wrong.
const BY_NAME: &str = " WHERE c.is_paper = 1 AND c.name = ?1";

/// The front face of a double-faced card, as a **range** rather than a `substr` expression.
///
/// `cards.name` carries `"A // B"` and a list naming only the front is the commonest way a DFC
/// is written down. The old form, `substr(c.name, 1, instr(c.name, ' // ') - 1) = ?1`, is an
/// expression over a column and can never use an index; a range on `c.name` can, and does.
/// See [`front_face_range`] for why the two bounds are exact.
const BY_FRONT_FACE: &str = " WHERE c.is_paper = 1 AND c.name >= ?1 AND c.name < ?2";

/// [`BY_NAME`], narrowed to the set the reader named.
const BY_SET_AND_NAME: &str = " WHERE c.is_paper = 1 AND c.set_code = ?1 AND c.name = ?2";

/// [`BY_FRONT_FACE`], narrowed to the set the reader named.
const BY_SET_AND_FRONT: &str =
    " WHERE c.is_paper = 1 AND c.set_code = ?1 AND c.name >= ?2 AND c.name < ?3";

/// The fold arm's tail. Two differences from [`FROM_CARDS`], and both are the point:
/// `printing_count` is a literal because [`fold_match`] overwrites it in Rust, and
/// `released_at` is selected because that arm's ordering happens in Rust and has to be handed
/// the key it orders on.
const FOLD_COLUMNS: &str =
    ",\n        0 AS printing_count, coalesce(c.released_at, '0000-00-00') AS released";

/// The fold arm's source, and a cap that is **ordered**, which is the whole of the fix.
///
/// `cards_fts` narrows the candidate set so the fold never scans the corpus. What the first
/// version got wrong is the truncation: `LIMIT 200` with no `ORDER BY` keeps the 200 **lowest
/// rowids**, and `cards` is dropped and recreated by every sync, which renumbers every rowid.
/// So the arm answered a different card after a sync than before it, in a module whose
/// headline rule is that the same list resolves the same way twice. The cap now keeps the 200
/// rows [`MATCH_ORDER`] itself would have preferred, so truncation is deterministic and drops
/// the candidates least likely to win.
///
/// It is not free and the cost is named. Measured 2026-08-12 over the live corpus, on the
/// broadest phrase in the corpus (`"Island"`, 1 971 candidates): the old unordered form 377 ms,
/// this one 1 149 ms, and no cap at all 4 481 ms. But a broad phrase is precisely what never
/// reaches here — this arm runs only when the exact name and the front-face range both matched
/// nothing, and `Island` is a card. The realistic figures are the ones that matter:
/// `"jotun grunt"` 0.1 ms (3 candidates), `"sol ring"` 0.9 ms (136), `"swords to plowshares"`
/// 1.0 ms (94).
///
/// **Filtering the `MATCH` to the `name` column was tried and is a loss** — `name : "Island"`
/// cuts 1 971 candidates to 909 and costs *more* (927 ms against 377), because the column
/// filter gives up FTS5's plain phrase iterator. Measured, not assumed.
const FTS_FROM_AND_WHERE: &str = "\n   FROM cards_fts f JOIN cards c ON c.rowid = f.rowid
  WHERE cards_fts MATCH ?1 AND c.is_paper = 1";

/// How many FTS candidates the fold arm will judge. See [`FTS_FROM_AND_WHERE`].
const FOLD_CANDIDATES: usize = 200;

/// The half-open range of names whose **front face** is `name`: `["{name} // ", "{name} //!")`.
///
/// Exact, not a heuristic, and the argument is short enough to check. SQLite compares `TEXT`
/// under BINARY as a byte-wise memcmp, the prefix every such name shares is `"{name} // "`,
/// and the bound replaces that prefix's last byte — a space, `0x20` — with `!`, `0x21`. A
/// string sorts inside the range exactly when it carries the prefix: anything sharing the
/// first `"{name} //"` bytes must then hold a byte `>= 0x20` and `< 0x21`, which is the space
/// itself, and anything differing earlier falls the same side of both bounds. So there is no
/// sentinel to guess and no false positive to fear — measured against the live corpus, `"Sol"`
/// returns 0 rows while `"Sol Ring"` has 136 printings, and `"Kolvori, God of Kinship"`,
/// `"Fire"` and `"Bonecrusher Giant"` each return exactly their own split-name printings.
///
/// The `+ 1` on a byte can never overflow because the byte incremented is always `0x20`.
fn front_face_range(name: &str) -> (String, String) {
    (format!("{name} // "), format!("{name} //!"))
}

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

/// How well this card's name folds to what the reader typed: `0` for the whole name, `1` for
/// the front face only, `None` for neither.
///
/// **A rank rather than a bool, for [`BY_NAME`]'s reason one layer up.** The SQL arms keep the
/// exact name ahead of a front-face match by asking in sequence; this arm asks once and sorts,
/// so the same preference has to be a sort key or the art series wins here instead. It was
/// measured winning: with a plain boolean filter, 3 of the reference list's 105 names came back
/// as `"N // N"` art-series rows, the same three the `OR` arm lost.
///
/// The empty-string trap of [`BY_NAME`] lives here too — a single-faced name has no front half,
/// so `wanted` being `""` would rank everything — and [`fold_match`] returns before this is
/// ever reached with one.
fn fold_rank(card_name: &str, wanted: &str) -> Option<u8> {
    if fold_name(card_name) == wanted {
        return Some(0);
    }
    card_name
        .split_once(" // ")
        .filter(|(front, _)| fold_name(front) == wanted)
        .map(|_| 1)
}

/// The last arm: fold both sides and compare in Rust.
///
/// The comparison cannot be SQL — a fold is a 40-entry table, and SQLite's `lower()` is ASCII
/// and its `NOCASE` collation more so. So `cards_fts` picks the candidates and Rust judges
/// them, which is also why the ordering is repeated here by hand: this arm must reach the same
/// printing [`MATCH_ORDER`] would, or an import stops being deterministic at exactly the names
/// that needed the most help.
///
/// `printing_count` is the number of candidates that survived the fold, computed here because
/// this arm's SQL selects a literal `0` for it: a `count(*) OVER ()` would count everything FTS
/// returned, and the reader is choosing between printings of *their* card rather than between
/// everything that happened to mention it.
fn fold_match(stmt: &mut Statement<'_>, name: &str) -> Option<ImportMatch> {
    let wanted = fold_name(name);
    if wanted.is_empty() {
        return None;
    }
    // The MATCH argument is a quoted phrase with its own quotes doubled — an unescaped name
    // containing a quote is an FTS syntax error, not a miss. Measured 2026-08-12: a bare
    // `"one " two"` answers `unterminated string`, and the doubled form answers rows.
    let phrase = format!("\"{}\"", name.replace('"', "\"\""));
    let mut kept: Vec<(u8, ImportMatch, String)> = stmt
        .query_map(params![phrase], |r| Ok((read_match(r)?, r.get(23)?)))
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|(m, rel)| Some((fold_rank(&m.name, &wanted)?, m, rel)))
        .collect();
    let count = i64::try_from(kept.len()).unwrap_or(i64::MAX);
    // The whole name ahead of a front face, then `MATCH_ORDER`'s three keys in its own order.
    kept.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.owned_quantity.cmp(&a.1.owned_quantity))
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| b.1.card_id.cmp(&a.1.card_id))
    });
    let mut winner = kept.into_iter().next()?.1;
    winner.printing_count = count;
    Some(winner)
}

/// Every line of a parsed decklist, resolved to a printing this app has.
///
/// Six statements, prepared once and reused down the list, tried in the order the reader's own
/// intent runs out — **narrowest first, and the exact name always ahead of a front face**:
///
/// 1. **A set and a collector number** name one printing, and are taken at their word.
/// 2. **The set, with the name** — because a hint whose *number* named nothing usually still
///    has the right set, and discarding it there throws away the reader's best information at
///    the moment it is most likely to be right.
/// 3. **The set, with the name as a front face.**
/// 4. **The name**, exactly.
/// 5. **The name as a front face** of a `"A // B"` printing.
/// 6. **The folded name**, through `cards_fts` — see [`fold_match`].
///
/// A hint that was present and was not honoured sets `hint_missed` and **falls through**: the
/// reader wanting a printing this app has not got is never a reason to lose the card.
/// `hint_missed` means *some part of what the reader wrote about the printing was not used* —
/// so a collector number that named nothing sets it even when the set and name then answer,
/// and a collector number with no set beside it sets it without being tried at all (a
/// collector number is not unique across sets, so it can only ever narrow one).
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
    let mut by_printing = prepare(&format!("{scan}{BY_SET_AND_NUMBER}{MATCH_ORDER} LIMIT 1"))?;
    let mut by_set_and_name = prepare(&format!("{scan}{BY_SET_AND_NAME}{MATCH_ORDER} LIMIT 1"))?;
    let mut by_set_and_front = prepare(&format!("{scan}{BY_SET_AND_FRONT}{MATCH_ORDER} LIMIT 1"))?;
    let mut by_name = prepare(&format!("{scan}{BY_NAME}{MATCH_ORDER} LIMIT 1"))?;
    let mut by_front = prepare(&format!("{scan}{BY_FRONT_FACE}{MATCH_ORDER} LIMIT 1"))?;
    let mut by_fold = prepare(&format!(
        "{MATCH_COLUMNS}{FOLD_COLUMNS}{FTS_FROM_AND_WHERE}{MATCH_ORDER} LIMIT {FOLD_CANDIDATES}"
    ))?;

    let mut out = Vec::with_capacity(lines.len());
    for (index, l) in lines.iter().enumerate() {
        // Trimmed, and an empty name is no name at all: the front-face *range* of `""` is
        // `[" // ", " //!")`, which is a real range over real names, so a blank line reaching
        // the name arms would resolve to an arbitrary printing rather than to nothing. A
        // printing hint needs no name and is still honoured.
        let name = l.name.trim();
        let front = (!name.is_empty()).then(|| front_face_range(name));
        let mut matched = None;
        let mut hint_missed = false;

        if let Some(set) = given(&l.set_code) {
            // Binary, so `idx_cards_set_cn` is usable — and lower-case, because 0 of the
            // corpus's 116 695 rows carry a set code in any other case while a parser that
            // upper-cases `(MH2)` is the ordinary source of one. See `BY_SET_AND_NUMBER`.
            let set = set.to_lowercase();
            let number = given(&l.collector_number);
            if let Some(number) = number {
                matched = one(&mut by_printing, params![&set, number]);
            }
            // Set before the fallbacks below, so a number that named nothing stays reported
            // even when the set and name go on to answer.
            hint_missed = matched.is_none();
            if matched.is_none() && !name.is_empty() {
                matched = one(&mut by_set_and_name, params![&set, name]).or_else(|| {
                    front
                        .as_ref()
                        .and_then(|(lo, hi)| one(&mut by_set_and_front, params![&set, lo, hi]))
                });
                if number.is_none() {
                    hint_missed = matched.is_none();
                }
            }
        } else if given(&l.collector_number).is_some() {
            hint_missed = true;
        }

        if matched.is_none() && !name.is_empty() {
            matched = one(&mut by_name, params![name])
                .or_else(|| {
                    front
                        .as_ref()
                        .and_then(|(lo, hi)| one(&mut by_front, params![lo, hi]))
                })
                .or_else(|| fold_match(&mut by_fold, name));
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
/// On the blocking pool against `db_read`, like every other read: a list of a few hundred names
/// is six prepared statements and a few hundred index lookups — 11.6 ms for a 105-line
/// commander list, measured over the live corpus — which is small but not free, and it must
/// never queue behind an ingest.
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

    /// Eleven printings, shaped around the questions this module has to answer.
    ///
    /// Four **paper** Sol Rings and one digital one, because every ordering rule needs more
    /// than one printing of a name to order and `printing_count` needs a digital printing to
    /// leave out. `40k` and `clb` are given the **same** `released_at` deliberately — the real
    /// corpus is full of sets that share a release date, and without a tie the `id` tie-break
    /// that makes an import deterministic has nothing to break.
    ///
    /// Three are one each: a double-faced card written the way a decklist writes it (front face
    /// only), a name with a diacritic in it, and an Arena-only card whose *only* printing is
    /// digital.
    ///
    /// **The Henzie pair is real and is the whole art-series trap in two rows.** Both printings
    /// exist (`ncc` 102 and the `asnc` art series 40), both are paper, and both were released
    /// **2022-04-29** — so nothing but the id separates them, and the id here is chosen to sort
    /// the art series *above* the card exactly as the live corpus's uuids do.
    ///
    /// **`"Ach! Hans, Run!"` is the FTS-escaping fixture, and the quotes Scryfall prints around
    /// it are the whole point** — see `a_name_with_quotes_in_it_survives_the_fts_query` for why
    /// a name whose quotes sit in the *middle*, as Henzie's do, cannot pin that behaviour, and
    /// why one that merely ends in a quote cannot either.
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
                  '{"historic":"legal"}',NULL,NULL,NULL,'{}'),
                 ('henzie-ncc','o-hen','Henzie "Toolbox" Torre','ncc','102','en','2022-04-29',1,
                  'normal','mythic','{1}{B}{R}{G}',4.0,'Legendary Creature — Human Warrior',
                  'Blitz','BRG','BRG','{"commander":"legal"}','3','3','{"usd":"5.00"}','{}'),
                 ('henzie-zart','o-hzt',
                  'Henzie "Toolbox" Torre // Henzie "Toolbox" Torre','asnc','40','en',
                  '2022-04-29',1,'art_series','common',NULL,NULL,'Art Series',NULL,'','',
                  '{}',NULL,NULL,NULL,'{}'),
                 ('ach','o-ach','"Ach! Hans, Run!"','ugl','3','en','1998-08-11',1,'normal',
                  'rare','{2}{R}{R}',4.0,'Enchantment','At the beginning of your upkeep …',
                  'R','R','{}',NULL,NULL,'{"usd":"9.00"}','{}');"#,
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

    /// A blank name must resolve to nothing rather than to whatever sorts first.
    ///
    /// The guard predates the range arms and still earns its keep under them: the front-face
    /// range of `""` is `[" // ", " //!")`, which is a perfectly real range over real names —
    /// it just happens to select every card whose name begins with a space, and it would select
    /// far more if a name ever did. Under the *original* SQL the hole was wider and is what
    /// found the guard: `substr(name, 1, instr(name, ' // ') - 1) = ''` was **true of every
    /// single-faced row**, measured.
    #[test]
    fn a_blank_name_resolves_to_nothing_rather_than_to_whatever_sorts_first() {
        let conn = seeded();
        assert!(resolve_one(&conn, line("   ")).matched.is_none());
        assert!(resolve_one(&conn, line("")).matched.is_none());
        let the_old_hole: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards WHERE substr(name, 1, instr(name, ' // ') - 1) = ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            the_old_hole, 9,
            "every single-faced row in the fixture — which is what the guard was found by"
        );
    }

    /// The trap that made splitting [`BY_NAME`] and [`BY_FRONT_FACE`] a correctness fix rather
    /// than a tuning one. Scryfall's art series print `"N // N"`, those rows are paper, and
    /// under the old single `OR` arm `MATCH_ORDER` was free to prefer one — which it did, for
    /// **3 of 105** lines of the reference list, measured over the live corpus. Both fixture
    /// rows share a release date, so only the id separates them and the art series wins it.
    #[test]
    fn a_real_card_beats_the_art_series_that_repeats_its_name() {
        let conn = seeded();
        assert_eq!(
            matched_id(&conn, line("Henzie \"Toolbox\" Torre")),
            "henzie-ncc",
            "the card, not `Henzie \"Toolbox\" Torre // Henzie \"Toolbox\" Torre`"
        );
        // And the front-face arm is still reachable — it is second, not deleted.
        assert_eq!(
            matched_id(&conn, line("Kolvori, God of Kinship")),
            "kolvori"
        );
    }

    /// The same preference, one layer down. The fold arm asks once and sorts, so "whole name
    /// beats front face" has to be a sort key there ([`fold_rank`]) rather than an order of
    /// asking. Lower-casing is what forces this line through the fold arm at all, now that the
    /// SQL arms are binary — which makes this the test that pins both halves of that trade.
    #[test]
    fn the_fold_arm_also_prefers_the_card_to_the_art_series() {
        let conn = seeded();
        assert_eq!(
            matched_id(&conn, line("henzie \"toolbox\" torre")),
            "henzie-ncc"
        );
    }

    /// 28 real cards carry a double quote, and an unescaped one can be an FTS **syntax error**
    /// rather than a miss. Fail-open means a regression here would be silent — every such name
    /// would simply stop matching, with nothing in the log to say why.
    ///
    /// **The fixture has to be a name whose quotes are at its *edges*, and finding that out is
    /// the whole reason this test was rewritten.** The obvious fixture is
    /// `Henzie "Toolbox" Torre`, and it does not discriminate: unescaped, [`fold_match`] wraps
    /// it as `"henzie "toolbox" torre"`, which FTS5 reads as a phrase, a bareword and a second
    /// phrase — an implicit AND that still returns the row. The earlier version of this test
    /// used exactly that name and **passed with `.replace('"', "\"\"")` deleted**, pinning
    /// nothing it claimed to.
    ///
    /// A trailing quote alone is not enough either, measured the same way 2026-08-12:
    /// `Kongming, "Sleeping Dragon"` unescaped wraps to `"kongming, "sleeping dragon""`, whose
    /// final `""` FTS5 accepts as an empty phrase — an AND again, and the row still came back.
    /// **Every real card name carries an even number of quotes**, so the wrapper can never be
    /// left unterminated by one; the error has to come from what the *barewords* between the
    /// quoted runs turn out to be.
    ///
    /// `"Ach! Hans, Run!"` is that name — Scryfall's own spelling includes the quotation marks.
    /// Unescaped it wraps to `""Ach! Hans, Run!""`, whose leading `""` closes an empty phrase
    /// and leaves `Ach! Hans, Run!` as **bare** query text, where `!` is not a token FTS5 has a
    /// rule for: `fts5: syntax error near "!"`, measured 2026-08-12 against this fixture.
    /// FTS5 raises it while **stepping**, not while preparing, so [`fold_match`]'s fail-open
    /// swallows it and the symptom is a card that is simply never found — which is exactly what
    /// deleting the escaping and running this test produces (`resolved to nothing`).
    ///
    /// The lower-case spelling is deliberate: it is what routes the line through the fold arm,
    /// which is the only arm that builds an FTS query.
    #[test]
    fn a_name_with_quotes_in_it_survives_the_fts_query() {
        let conn = seeded();
        assert_eq!(
            matched_id(&conn, line("\"ach! hans, run!\"")),
            "ach",
            "the quotes are doubled, so FTS reads one literal phrase"
        );
        // Quotes in the middle of a name must keep working too — they are the common shape,
        // and they are the shape that survives even an unescaped query.
        assert_eq!(
            matched_id(&conn, line("henzie \"toolbox\" torre")),
            "henzie-ncc"
        );
        // A name that is nothing but hostile FTS syntax is a miss, never an error.
        let rows = resolve_lines(&conn, &[line("\" AND NEAR( x:")]).expect("never an `Err`");
        assert!(rows[0].matched.is_none());
    }

    /// [`given`]'s trim. A hint of `Some("  ")` is what a trailing tab in a pasted export
    /// leaves behind, and bound into `c.set_code = ?1` it matches no set — so every line of
    /// that paste would report a missed hint it never had.
    #[test]
    fn a_blank_hint_is_no_hint_and_is_not_reported_as_missed() {
        let conn = seeded();
        let row = resolve_one(
            &conn,
            ResolveLine {
                name: "Sol Ring".to_owned(),
                set_code: Some("   ".to_owned()),
                collector_number: Some(String::new()),
            },
        );
        assert!(!row.hint_missed, "there was no hint to miss");
        assert_eq!(row.matched.unwrap().card_id, "sol-clb");
    }

    /// Three things about what `hint_missed` means, which is *some part of what the reader
    /// wrote about the printing was not used*.
    #[test]
    fn a_hint_the_reader_wrote_and_did_not_get_is_always_reported() {
        let conn = seeded();

        // A collector number with no set cannot be used at all — a number is not unique across
        // sets — but the reader still wrote one.
        let bare = resolve_one(
            &conn,
            ResolveLine {
                name: "Sol Ring".to_owned(),
                set_code: None,
                collector_number: Some("263".to_owned()),
            },
        );
        assert!(bare.hint_missed);
        assert_eq!(bare.matched.unwrap().card_id, "sol-clb");

        // A wrong number in a right set keeps the set — and still reports the number.
        let salvaged = resolve_one(&conn, hinted("Sol Ring", "c21", Some("9999")));
        assert!(salvaged.hint_missed, "the number named nothing");
        assert_eq!(
            salvaged.matched.unwrap().card_id,
            "sol-c21",
            "and the set was still right"
        );

        // A set the reader wrote in upper case is the ordinary case, and is honoured.
        let shouty = resolve_one(&conn, hinted("Sol Ring", "C21", None));
        assert!(!shouty.hint_missed);
        assert_eq!(shouty.matched.unwrap().card_id, "sol-c21");
    }

    /// The front-face range is a range, so it has to be exact at both ends: a query that is a
    /// *prefix* of a real front face must not match it, and one that is a whole single-faced
    /// name must not be dragged in either.
    #[test]
    fn the_front_face_range_catches_the_card_and_nothing_beside_it() {
        assert_eq!(
            front_face_range("Kolvori"),
            ("Kolvori // ".to_owned(), "Kolvori //!".to_owned())
        );
        let conn = seeded();
        // "Kolvori" alone is a prefix of the real front face and must not resolve to it.
        assert!(resolve_one(&conn, line("Kolvori")).matched.is_none());
        // Nor may a front-face query reach a single-faced card that merely starts the same way.
        assert!(resolve_one(&conn, line("Sol")).matched.is_none());
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

    /// `printing_count` is how many rows *this line's rule* found, which through the bare-name
    /// arm is the card's paper printings — and through the other arms is not. Both halves are
    /// asserted, because the field's doc is what Task 6 will build an affordance on.
    #[test]
    fn printing_count_is_the_number_of_paper_printings_of_that_name() {
        let conn = seeded();
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.printing_count, 4,
            "four paper printings, and Arena's is not one"
        );
        let hinted_row = resolve_one(&conn, hinted("Sol Ring", "c21", Some("263")))
            .matched
            .unwrap();
        assert_eq!(
            hinted_row.printing_count, 1,
            "through a printing hint it counts what the hint named, not the card's printings"
        );
    }
}
