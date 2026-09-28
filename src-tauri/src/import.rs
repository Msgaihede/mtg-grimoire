//! Importing a decklist: the one question TypeScript cannot answer.
//!
//! A reader pastes a list; the TypeScript half (`src/features/transfer/import/`, mirrored across
//! IPC by `src/lib/ipc.ts`) parses it into lines and
//! decides everything a *deck* decision is — which pile a card lands in, which card is the
//! commander, what the format is. What it cannot decide is **which printing in this app's
//! corpus a name means**, because that is a question about 116 k rows of data. So this module
//! answers exactly that, one line at a time — and then puts the answers in the deck, which is
//! the second thing TypeScript cannot do from where it stands: see [`commit_import`].
//!
//! Shaped like [`crate::card`] and [`crate::search`]: pure functions over a `Connection`,
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking pool.
//!
//! **Two halves, and they take different connections.** [`resolve_lines`] writes nothing at all
//! and reads through `db_read`, like every other read in this app. [`commit_import`] is the
//! write, and it takes the write connection through `db::lock_for` for one transaction — see
//! its own doc for the reason it exists at all, which is that a decklist must cost the
//! allocator **one** run rather than one per line.
//!
//! Three rules run through the read half:
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
use serde_json::json;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
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

/// `IMPORT_MODES[1]` by **index and not by spelling**, the discipline [`crate::deck_audit`]'s
/// kind constants apply to `AUDIT_KINDS`: the refusal above quotes that array, so a literal
/// `"replace"` here that drifted from it would leave the one mode a caller can name unreachable
/// while everything still compiled.
const REPLACE: &str = IMPORT_MODES[1];

/// What an import says when it was handed no lines at all.
///
/// A write that writes nothing is not a write — the same refusal [`crate::deck::add_card`]
/// gives a quantity of zero. It matters most in `replace`, where "do nothing" and "clear the
/// deck and put nothing back" are the same call with the same arguments, and only one of them
/// is what a reader who pasted an empty box meant.
pub const NOTHING_TO_IMPORT: &str = "There is nothing to import.";

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
/// of it the list asked for is the caller's arithmetic. Every hint is optional because most
/// decklist formats carry none of them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLine {
    pub name: String,
    /// A set **code** — or, since issue #555, a set **name** when the file had no code column
    /// (Deckbox's `Edition`, Dragon Shield's set column). [`resolve_lines`] tries it as a code
    /// first; see [`SetHints`] for when it is read as a name instead.
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    /// The language the file says its copy is in, as a Scryfall code (`ja`, `zhs`) — issue #555.
    /// **A preference and never a filter**: see [`preferred_lang`] for what is accepted and
    /// [`match_order`] for where it ranks. `#[serde(default)]`, so every caller written before
    /// the field — and a TypeScript `null` — is today's ordering exactly.
    #[serde(default)]
    pub lang: Option<String>,
}

/// The printing a line resolved to, and every fact the preview and the validation engine
/// need about it.
///
/// The card columns are `DECK_CARD_SELECT`'s card half **less its money**, so an imported card
/// and a card already in a deck are described by the same *judgeable* facts — a preview that
/// judged legality on a narrower set of columns than the editor would report a legal deck that
/// the editor then refuses. Two fields are the import's own: [`Self::owned_quantity`], because
/// "you already own this" is the reason a printing was chosen, and [`Self::printing_count`], so
/// the preview can say how many printings the reader is choosing between.
///
/// **No price rides here, and the omission is the fix rather than an oversight.** This struct
/// carried `unit_price_usd` while `DECK_CARD_SELECT` carried only that one currency; the
/// marketplace work then added `unit_price_eur` beside it there and not here, which is exactly
/// the drift the "copied verbatim" claim above existed to prevent, and the doc went on claiming
/// it for a merge. Three reasons the answer was *remove* rather than *keep up with it*:
///
/// * **Nothing reads it.** Swept 2026-08-12 across the whole frontend: every `unitPriceUsd` on
///   an `ImportMatch` is a fixture filling the field in as `null` — four of them
///   (`plan.test.ts`, `ImportDeckDialog.test.tsx`, `DeckEditor.test.tsx`, `DecksPage.test.tsx`)
///   plus the Storybook fake's `toImportMatch`. The import preview draws no money at all.
/// * **A price on a DTO that names no marketplace is wrong by rule.** A price is only meaningful
///   beside the marketplace it was quoted at, and this struct answers a *plan* rather than a
///   priced list — nothing in the request that builds it says where the reader shops.
/// * **A field that does not exist cannot drift**, which the price-feed work then proved twice
///   over: the twin fields this bullet was written against are themselves gone, replaced by a
///   single `unit_price` chosen by a `marketplace` query parameter. A preview that one day draws
///   a price will take the marketplace like every other priced read, against the rule as it
///   stands then.
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

/// The card half of `DECK_CARD_SELECT`, less its money, plus the two facts only an import
/// asks for.
///
/// **Copied from `deck.rs`'s `DECK_CARD_SELECT` rather than retyped**, so an import and the
/// editor cannot come to describe a card differently. Three deliberate differences, named here
/// so a reader diffing the two does not have to guess which are drift:
///
/// * **`c.finishes` is absent** — the column says which finishes a printing is *sold* in, which
///   is what the editor's foil marking and its `Set as foil` row read. A preview draws neither:
///   an imported line's own finish rides on [`ImportItem::finish`], off the file's `*F*` marker,
///   and needs no list to be read against.
/// * **The price column is absent**, and that is the one difference worth reading
///   [`ImportMatch`]'s doc for: `DECK_CARD_SELECT` builds a `unit_price` through
///   `sorting::price_expr` at the marketplace its query was given, and this list has no
///   marketplace to build one at. Nothing in the preview prices anything. (It read
///   `unit_price_usd` *and* `unit_price_eur` when this bullet was written; copying only the
///   dollar one is what the marketplace merge caught this constant doing, and the price-feed
///   work has since collapsed the pair.)
/// * **`owned_quantity` and `printing_count` are added**, because the import asks two questions
///   the editor does not.
///
/// Every other column is `DECK_CARD_SELECT`'s, in `DECK_CARD_SELECT`'s own order, so a diff of
/// the two lists is a diff of those three bullets and nothing else.
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
///
/// **The last column is built rather than literal**, by [`crate::collection_source`], so every
/// reader of "the printing you own" spells it the same way. `owned_quantity` is what
/// `MATCH_ORDER` ranks on first, so it decides which printing a line becomes.
fn match_columns(conn: &Connection) -> String {
    format!(
        "SELECT c.id, c.name, c.set_code, c.collector_number, c.lang,
        c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
        c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
        c.faces, c.game_changer,
        EXISTS(SELECT 1 FROM cards u
                WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon,
        {owned} AS owned_quantity",
        // Every copy, wherever it is filed: an import is matching a pasted line to a printing,
        // and "the one you already own" is the right tie-break whichever drawer it is in — this
        // ranking runs for a collection import as readily as a deck's, and neither has a deck to
        // be relative to at the point the printing is chosen.
        owned = crate::collection_source::copies_of_printing(
            conn,
            "c.id",
            crate::collection_source::Availability::Everything,
        )
    )
}

/// The five SQL arms' tail: their source, and the count only they compute.
const FROM_CARDS: &str = ",\n        count(*) OVER () AS printing_count\n   FROM cards c";

/// The order every arm shares: a printing you own, then an English one, then the newest, then
/// the id.
///
/// The `id` tie-break is not decoration — it is what makes an import **deterministic**, so
/// the same list pasted twice puts the same printings in the deck.
///
/// **The language term is third-from-last and its position is the whole decision.** Without it
/// a name-only line lands on whatever paper printing is newest, and 5 of the reference list's
/// 105 lines landed on one that is not English — measured 2026-08-12 in the shipped window over
/// the live corpus: `Akroma's Will → soa 131 [ja]`, `Arcane Signet → hoc 95 [dw]`,
/// `Mox Amber → hoc 96 [dw]`, `Elesh Norn, Mother of Machines → one 418 [ph]`,
/// `The Wandering Rescuer → pwcs 2026-3 [ja]`. Re-measured with this term through `node:sqlite`
/// against the same corpus, driving these statements' own text: **105 of 105 English**, those
/// five and no others moved.
///
/// * **Behind `owned_quantity`**, because a Japanese Sol Ring you own is a Sol Ring you own —
///   the whole promise of that first key is that a list you have the cards for puts *your*
///   copies in the deck, and an English printing you have not got claims nothing from the
///   binder.
/// * **Ahead of the date**, because "newest" is a tie-break for which printing looks current
///   and is precisely the key that produced those five. A reader pasting an English decklist
///   asked for those cards, not for the most recent language they were printed in.
///
/// `cards.lang` is `TEXT NOT NULL` (`schema.rs`) holding Scryfall's own codes — 19 of them in
/// the live corpus, 0 NULL, measured — so this is a plain equality and never a three-valued
/// one, and no wider locale notion is invented: English or not.
///
/// [`fold_match`] repeats these keys in Rust and must carry this one in this position too.
///
/// A line that says which language its copy is in puts **one more key ahead of all four** —
/// see [`match_order`]. This constant is the ordering of every line that says nothing, and it is
/// what [`match_order`] answers, byte for byte, when there is nothing to prefer.
const MATCH_ORDER: &str = " ORDER BY owned_quantity DESC, (c.lang = 'en') DESC,
        coalesce(c.released_at, '0000-00-00') DESC, c.id DESC";

/// The language a line asked for, if it asked for one this module will put in SQL.
///
/// **Two to three ASCII letters, lowercased, or nothing** — the shape of every one of Scryfall's
/// codes (`en`, `ja`, `zhs`, `grc`, `qya`), and the whole of the fence that makes inlining it as a
/// literal in [`match_order`] safe: a value that could close a quote cannot pass it. Anything
/// else — `Japanese`, a stray `ja-JP`, a blank — is **ignored rather than refused**, because this
/// is a preference and a line whose preference is unreadable still has a name to resolve by.
/// `@/lib/languages`' `languageCode` is what turns a file's cell into a code before it gets here.
fn preferred_lang(raw: &Option<String>) -> Option<String> {
    let code = raw.as_deref()?.trim().to_ascii_lowercase();
    ((2..=3).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase())).then_some(code)
}

/// [`MATCH_ORDER`], with a line's language preference in front of it (issue #555).
///
/// **Ahead of `owned_quantity`, and that position is the decision.** [`MATCH_ORDER`] puts the
/// copy you own first because a line that says nothing about its printing is best answered with
/// cardboard the reader has. A line that says `Japanese` is not saying nothing: the file is
/// describing a Japanese copy — usually a collection export describing *that* copy — and an
/// English printing the reader happens to own is a different object. So the file's word outranks
/// the binder's, and the binder still breaks the tie among printings in that language.
///
/// **A preference and never a filter.** It is an `ORDER BY` key, so a name with no printing in
/// that language resolves exactly as it would have — which is most names, because Scryfall's
/// default bulk data carries a non-English printing only where there is no English one — and
/// `printing_count` (a window over every matched row) does not move with it.
///
/// **Inlined as a literal rather than bound**, and [`preferred_lang`] is what makes that safe. A
/// bound `?N` here would have to take a different position in each of the six arms and be bound
/// by every one of them, and rusqlite refuses a statement handed fewer values than it has holes.
/// What the literal costs is one set of six statements per **distinct** language in the list,
/// prepared the first time a line asks for it and reused by every later line that does — see
/// [`Arms`] — so a collection export in three languages prepares eighteen statements beside the
/// six every list prepares, not one per line.
fn match_order(lang: Option<&str>) -> String {
    match lang {
        None => MATCH_ORDER.to_owned(),
        Some(lang) => MATCH_ORDER.replacen(
            " ORDER BY ",
            &format!(" ORDER BY (c.lang = '{lang}') DESC, "),
            1,
        ),
    }
}

/// The printing hint at full strength: a set code and a collector number name one printing,
/// and the reader who wrote them down meant them. No name is consulted **in the SQL**, so a
/// list whose names are in another language still lands on the right cards — but the row that
/// comes back is checked against the line's name in Rust before it is kept, because a hint may
/// only narrow *which printing of the named card* to take. See [`hint_names_the_card`], which
/// is where that rule and the bug it closed are written down.
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

/// One [`ImportMatch`] out of a row of [`match_columns`].
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
        owned_quantity: r.get(20)?,
        printing_count: r.get(21)?,
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

/// Does the printing a hint landed on **name the card the line named**?
///
/// **A hint narrows which printing of the named card to take; it never overrides which card.**
/// [`BY_SET_AND_NUMBER`] consults no name at all — deliberately, and that is what lets a
/// non-English list land on the right cards — but nothing downstream checked that the row it
/// found had anything to do with the line, and `hint_missed` could not say so because the hint
/// did not miss. Measured 2026-08-12 in the shipped window (a **debug** build) over the live
/// 116 695-row corpus: `1 Captain Sisay (brc) 132` imported **Arcane Signet**, because `brc`
/// 132 *is* Arcane Signet — `hint_missed: false`, and the preview drew no problem list at all.
/// A stale collector number, a renumbered reprint or a hand-edited list all produce it.
///
/// This is [`crate::deck::swap_printing`]'s guard in a second place and for the same reason:
/// "swap this printing" must never become "swap this card", and neither must "this printing,
/// of this card".
///
/// **The test is the most permissive of the three the name arms use, which is what keeps the
/// guard from refusing a hint the name rules would have honoured.** [`fold_rank`] accepts the
/// whole folded name *and* the folded front face, and both binary arms imply their folded form
/// — [`BY_NAME`]'s exact match and [`BY_FRONT_FACE`]'s range — because folding is a function,
/// so equal names fold equal. A hint is therefore discarded only when **no** name arm could
/// have reached that row either, which is exactly the case where the reader gets a card they
/// did not ask for.
///
/// The set-with-name arms need no guard of their own: [`BY_SET_AND_NAME`] and
/// [`BY_SET_AND_FRONT`] put the name in the `WHERE` clause, so a row they answer already bears
/// it.
///
/// An empty name is not a disagreement. A line that gave only a printing gave no card name for
/// that printing to contradict, and [`resolve_lines`] honours such a hint on purpose.
fn hint_names_the_card(card_name: &str, wanted: &str) -> bool {
    wanted.is_empty() || fold_rank(card_name, &fold_name(wanted)).is_some()
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
///
/// `lang` is the line's [`preferred_lang`], and it takes [`match_order`]'s position here too:
/// **after the fold rank and ahead of `owned_quantity`**. After the rank, because the rank is
/// this arm's spelling of the SQL arms' *sequence* — the exact name is asked before the front
/// face whatever language either is in — and ahead of everything [`MATCH_ORDER`] orders by,
/// because that is where [`match_order`] puts it. `None` compares every candidate equal on it, so
/// a line that says nothing is sorted exactly as it was. The statement handed in must be the one
/// [`Arms::prepare`] built for the same `lang`, or the `LIMIT` would have kept the 200 candidates
/// a different ordering preferred.
fn fold_match(stmt: &mut Statement<'_>, name: &str, lang: Option<&str>) -> Option<ImportMatch> {
    let wanted = fold_name(name);
    if wanted.is_empty() {
        return None;
    }
    // The MATCH argument is a quoted phrase with its own quotes doubled — an unescaped name
    // containing a quote is an FTS syntax error, not a miss. Measured 2026-08-12: a bare
    // `"one " two"` answers `unterminated string`, and the doubled form answers rows.
    let phrase = format!("\"{}\"", name.replace('"', "\"\""));
    let mut kept: Vec<(u8, ImportMatch, String)> = stmt
        // Column 22 is `released`, the one column `FOLD_COLUMNS` adds past what `read_match`
        // consumes — so this index is `match_columns`' width plus `printing_count`, and it moved
        // when the price column left. Nothing but a test catches a slip here: `r.get` is
        // positional and every neighbour is a `TEXT` SQLite would happily hand over instead.
        .query_map(params![phrase], |r| Ok((read_match(r)?, r.get(22)?)))
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|(m, rel)| Some((fold_rank(&m.name, &wanted)?, m, rel)))
        .collect();
    let count = i64::try_from(kept.len()).unwrap_or(i64::MAX);
    // The whole name ahead of a front face, then the line's language, then `MATCH_ORDER`'s four
    // keys in its own order. `false < true`, so comparing `b` to `a` puts a preferred row first
    // exactly as `DESC` does.
    let english = |m: &ImportMatch| m.lang == "en";
    let asked = |m: &ImportMatch| lang.is_some_and(|l| m.lang == l);
    kept.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| asked(&b.1).cmp(&asked(&a.1)))
            .then_with(|| b.1.owned_quantity.cmp(&a.1.owned_quantity))
            .then_with(|| english(&b.1).cmp(&english(&a.1)))
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| b.1.card_id.cmp(&a.1.card_id))
    });
    let mut winner = kept.into_iter().next()?.1;
    winner.printing_count = count;
    Some(winner)
}

/// The six arms of [`resolve_lines`], prepared at one ordering.
///
/// One of these per **distinct** [`preferred_lang`] in a list, plus the one every list prepares
/// for the lines that name no language — see [`match_order`] for why the language is a literal in
/// the SQL and therefore a statement of its own. Built once and reused by every line that asks for
/// the same ordering, which is what keeps "six statements, reused down the list" true of a
/// collection export in three languages as much as of a pasted decklist in none.
struct Arms<'c> {
    by_printing: Statement<'c>,
    by_set_and_name: Statement<'c>,
    by_set_and_front: Statement<'c>,
    by_name: Statement<'c>,
    by_front: Statement<'c>,
    by_fold: Statement<'c>,
}

impl<'c> Arms<'c> {
    /// `columns` is [`match_columns`]' answer, built once by the caller so every arm of every
    /// ordering ranks on the same `owned_quantity` expression.
    fn prepare(conn: &'c Connection, columns: &str, lang: Option<&str>) -> Result<Self, String> {
        let order = match_order(lang);
        let scan = format!("{columns}{FROM_CARDS}");
        let prepare = |sql: String| {
            conn.prepare(&sql)
                .map_err(|e| format!("the decklist could not be resolved: {e}"))
        };
        Ok(Self {
            by_printing: prepare(format!("{scan}{BY_SET_AND_NUMBER}{order} LIMIT 1"))?,
            by_set_and_name: prepare(format!("{scan}{BY_SET_AND_NAME}{order} LIMIT 1"))?,
            by_set_and_front: prepare(format!("{scan}{BY_SET_AND_FRONT}{order} LIMIT 1"))?,
            by_name: prepare(format!("{scan}{BY_NAME}{order} LIMIT 1"))?,
            by_front: prepare(format!("{scan}{BY_FRONT_FACE}{order} LIMIT 1"))?,
            by_fold: prepare(format!(
                "{columns}{FOLD_COLUMNS}{FTS_FROM_AND_WHERE}{order} LIMIT {FOLD_CANDIDATES}"
            ))?,
        })
    }
}

/// What each distinct set hint in one list means, asked once per hint rather than once per line.
///
/// **A set hint may be a set _name_** (issue #555). Deckbox's `Edition` column holds
/// `Commander Legends` and Dragon Shield identifies a printing by set name, so a CSV with no code
/// column hands its name column over as `set_code`. [`Self::code_for`] tries a hint as a code
/// first — **a code always wins**, so no file that already worked can resolve differently — and
/// only when no printing carries that code does it read the hint as a name:
///
/// * **Against `sets.name`**, the `/sets` fetch's table: ~1 050 rows keyed on `code`, read whole
///   once per call and compared in Rust, so the missing index on `name` costs nothing worth
///   indexing. **`cards.set_name` is the fallback** for a database whose `sets` is empty — that
///   fetch is a second request an ingest can fail or skip, which is why `sync::sets_need_fetch`
///   exists — and it is a full scan of `cards`, paid once per call, only on such a database and
///   only once a hint has already missed as a code.
/// * **Folded by [`fold_name`]** on both sides, the fold the name arm already trusts: case, runs
///   of whitespace, a curly apostrophe in `Baldur’s Gate`, a diacritic. Wider than
///   "case-insensitive", and in exactly the directions a set name drifts — and the case half is
///   not optional, because an older Deckbox file's `Edition` column reaches here through the
///   parser's *code* fallback, which upper-cases it: `COMMANDER LEGENDS`, `MAGIC 2011`.
/// * **Exactly one code, or none.** A name two sets share names no printing, and guessing between
///   them would be the hint overriding the card's own name arms with a coin toss. Such a hint —
///   and one naming nothing — goes on as the lowercased text it arrived as, which is today's
///   behaviour exactly: it misses, `hint_missed` says so, and the name arms answer.
///
/// Fails open throughout: a query that errors reads as "this is a code", which is what the hint
/// was taken for before this existed.
#[derive(Default)]
struct SetHints {
    /// The hint, lowercased, to the code a line carrying it should use.
    codes: HashMap<String, String>,
    /// Every set's folded name beside its code, loaded the first time a hint is not a code.
    names: Option<Vec<(String, String)>>,
}

impl SetHints {
    /// The set code a trimmed, non-blank hint stands for. Lowercased either way, because 0 of
    /// the corpus's rows carry a set code in any other case — see [`BY_SET_AND_NUMBER`].
    fn code_for(&mut self, conn: &Connection, hint: &str) -> String {
        let lower = hint.to_lowercase();
        if let Some(code) = self.codes.get(&lower) {
            return code.clone();
        }
        let code = if Self::is_a_code(conn, &lower) {
            lower.clone()
        } else {
            self.by_name(conn, hint).unwrap_or_else(|| lower.clone())
        };
        self.codes.insert(lower, code.clone());
        code
    }

    /// Does any printing carry this set code? `idx_cards_set_cn`'s first column, so one index
    /// probe. Any printing and not only a paper one: a digital-only set's code is still a code,
    /// and reading it as a name would only find a different set to disagree with.
    fn is_a_code(conn: &Connection, code: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM cards WHERE set_code = ?1)",
            [code],
            |r| r.get(0),
        )
        .unwrap_or(true)
    }

    /// The one set code whose name folds to this hint's, or `None` for no set or for several.
    fn by_name(&mut self, conn: &Connection, hint: &str) -> Option<String> {
        let wanted = fold_name(hint);
        if wanted.is_empty() {
            return None;
        }
        let names = self.names.get_or_insert_with(|| Self::load_names(conn));
        let mut codes = names
            .iter()
            .filter(|(name, _)| *name == wanted)
            .map(|(_, code)| code);
        let first = codes.next()?;
        codes.all(|code| code == first).then(|| first.clone())
    }

    /// `(folded name, code)` for every set this database can name — `sets` when it holds any
    /// row, `cards.set_name` otherwise. An error is an empty list, which names nothing.
    fn load_names(conn: &Connection) -> Vec<(String, String)> {
        let pairs = |sql: &str| -> rusqlite::Result<Vec<(String, String)>> {
            let mut stmt = conn.prepare(sql)?;
            let mut out = Vec::new();
            for row in stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))? {
                out.push(row?);
            }
            Ok(out)
        };
        let mut rows = pairs("SELECT code, name FROM sets").unwrap_or_default();
        if rows.is_empty() {
            rows =
                pairs("SELECT DISTINCT set_code, set_name FROM cards WHERE set_name IS NOT NULL")
                    .unwrap_or_default();
        }
        rows.into_iter()
            .map(|(code, name)| (fold_name(&name), code))
            .collect()
    }
}

/// Every line of a parsed decklist, resolved to a printing this app has.
///
/// Six statements, prepared once per ordering and reused down the list (see [`Arms`]), tried in
/// the order the reader's own intent runs out — **narrowest first, and the exact name always
/// ahead of a front face**:
///
/// 1. **A set and a collector number** name one printing, and are taken at their word about
///    *which printing* — never about *which card*, which is [`hint_names_the_card`]'s guard:
///    a row whose name is not this line's is discarded exactly as a number that named nothing
///    would be.
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
/// Two things a line may say besides its name and printing, both since issue #555 and both
/// preferences rather than filters: **a language**, which reorders every arm ([`match_order`]),
/// and **a set hint that is a set's name** rather than its code ([`SetHints`]), which is turned
/// into that code before arm 1 and then travels exactly as a code would.
///
/// Only `prepare` can fail the call. Everything after it degrades to `matched: None`.
pub fn resolve_lines(
    conn: &Connection,
    lines: &[ResolveLine],
) -> Result<Vec<ImportResolveRow>, String> {
    // Built once and reused by every arm of every ordering below, so every arm ranks on the
    // same `owned_quantity` expression.
    let columns = match_columns(conn);
    // Keyed by the line's preferred language. The no-language set is prepared up front, before
    // any line is read, so a broken schema still fails the whole call at once as it always did;
    // every other set is prepared the first time a line asks for it.
    let mut by_lang: HashMap<Option<String>, Arms<'_>> = HashMap::new();
    by_lang.insert(None, Arms::prepare(conn, &columns, None)?);
    let mut sets = SetHints::default();

    let mut out = Vec::with_capacity(lines.len());
    for (index, l) in lines.iter().enumerate() {
        // Trimmed, and an empty name is no name at all: the front-face *range* of `""` is
        // `[" // ", " //!")`, which is a real range over real names, so a blank line reaching
        // the name arms would resolve to an arbitrary printing rather than to nothing. A
        // printing hint needs no name and is still honoured.
        let name = l.name.trim();
        let front = (!name.is_empty()).then(|| front_face_range(name));
        let lang = preferred_lang(&l.lang);
        let arms = match by_lang.entry(lang.clone()) {
            Entry::Occupied(slot) => slot.into_mut(),
            Entry::Vacant(slot) => {
                let arms = Arms::prepare(conn, &columns, slot.key().as_deref())?;
                slot.insert(arms)
            }
        };
        let mut matched = None;
        let mut hint_missed = false;

        if let Some(set) = given(&l.set_code) {
            // Binary, so `idx_cards_set_cn` is usable — and lower-case, because 0 of the
            // corpus's 116 695 rows carry a set code in any other case while a parser that
            // upper-cases `(MH2)` is the ordinary source of one. See `BY_SET_AND_NUMBER`. A
            // hint that is no set's code but exactly one set's *name* comes back as that code.
            let set = sets.code_for(conn, set);
            let number = given(&l.collector_number);
            if let Some(number) = number {
                // Taken at its word about the *printing*, never about the *card* — see
                // `hint_names_the_card`. A row whose name is not this line's is the same event
                // as a number that named nothing: `hint_missed` below, and fall through to the
                // arms that do consult the name.
                matched = one(&mut arms.by_printing, params![&set, number])
                    .filter(|m| hint_names_the_card(&m.name, name));
            }
            // Set before the fallbacks below, so a number that named nothing stays reported
            // even when the set and name go on to answer.
            hint_missed = matched.is_none();
            if matched.is_none() && !name.is_empty() {
                matched = one(&mut arms.by_set_and_name, params![&set, name]).or_else(|| {
                    front
                        .as_ref()
                        .and_then(|(lo, hi)| one(&mut arms.by_set_and_front, params![&set, lo, hi]))
                });
                if number.is_none() {
                    hint_missed = matched.is_none();
                }
            }
        } else if given(&l.collector_number).is_some() {
            hint_missed = true;
        }

        if matched.is_none() && !name.is_empty() {
            matched = one(&mut arms.by_name, params![name])
                .or_else(|| {
                    front
                        .as_ref()
                        .and_then(|(lo, hi)| one(&mut arms.by_front, params![lo, hi]))
                })
                .or_else(|| fold_match(&mut arms.by_fold, name, lang.as_deref()));
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
pub async fn import_resolve(
    state: tauri::State<'_, Arc<AppState>>,
    lines: Vec<ResolveLine>,
) -> Result<Vec<ImportResolveRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || resolve_lines(&lock_db_read(&state), &lines))
        .await
        .map_err(|e| format!("the decklist could not be resolved: {e}"))?
}

/// One line of a decklist, after TypeScript has decided everything a *deck* decision is.
///
/// The first three fields are the three answers this command cannot compute for itself: which
/// printing (resolved by [`resolve_lines`] and chosen, perhaps overridden, in the preview), how
/// many, and which pile. The category arrives as a **name** rather than an id because an
/// imported list names sections the deck may not have yet — and because the word itself is
/// `autoCategoryFor`'s to compute, exactly as it is for [`crate::deck::add_card`]'s name arm.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub card_id: String,
    pub quantity: i64,
    pub category_name: String,
    /// The file said this pile counts toward nothing — Archidekt's `{noDeck}`, which is exactly
    /// what `is_active = 0` means here.
    ///
    /// **Applied only to a pile this import creates.** A name the reader already has keeps
    /// whatever they set: an import may not reach into filing somebody did by hand, which is the
    /// same reasoning that makes `replace` clear the cards and leave the categories. The
    /// `existed` lookup [`commit_import`] already makes for `categories_created` is that fact, so
    /// this costs no second query.
    ///
    /// **The first item naming a pile decides**, because the name is memoised for the list. Every
    /// export in scope is consistent about it — Archidekt writes the same bracket on every card
    /// of a category — and a list that disagreed with itself has no better answer available.
    ///
    /// `#[serde(default)]` so every caller written before this field still deserialises: absent
    /// means an ordinary, counted pile, which is what an import has always made.
    #[serde(default)]
    pub inactive: bool,
    /// The line's `*F*` / `*E*` marker, as `deck_cards.finish` stores it — `None` is the regular
    /// copy and `"nonfoil"` never arrives, because `deck::normalise_finish` is what this goes
    /// through.
    ///
    /// **Part of the grain**, so a list naming the same printing foil on one line and plain on
    /// another lands as two rows rather than one summed. Which lines carry it is TypeScript's
    /// reading of the file (`parse.ts` reads the marker, `plan.ts` rides it here) — Rust
    /// supplies the write, TS draws the conclusion, exactly as `inactive` above does.
    ///
    /// `#[serde(default)]` for that field's reason: a caller written before this still
    /// deserialises, and absent is the regular copy, which is what an import has always made.
    #[serde(default)]
    pub finish: Option<String>,
    /// The label the file put on this card — Archidekt's `^Keeper,#4aab08^`, name half.
    ///
    /// **A name rather than an id, exactly as [`Self::category_name`] is**, and found-or-created
    /// the same way: an imported list names labels this app may not have yet, and which cards
    /// deserve which label is somebody else's decision arriving whole. The lookup is
    /// [`crate::schema::label_name_key`]'s — `deck_labels.name_key`'s own grain — so `keeper` and
    /// `Keeper` are one row.
    ///
    /// **The row that is already there is never renamed and never recoloured.** That is
    /// [`Self::inactive`]'s rule over a different table and it is the reader's own instruction:
    /// find the label, use it, ignore what the file said about its colour. A label is app-wide
    /// since schema v21, so the alternative would let a pasted decklist repaint a label in every
    /// deck they own.
    ///
    /// `#[serde(default)]`, and **absent means "say nothing about this card's label"** rather
    /// than "clear it". It is what an unticked label sends, and it is what makes a `merge` onto a
    /// card the reader labelled by hand keep their label — see the `ON CONFLICT` in
    /// [`commit_import`], which coalesces rather than overwrites.
    #[serde(default)]
    pub label_name: Option<String>,
    /// That label's colour, as `deck_labels.color` stores one — `#rrggbb` from
    /// `features/decks/labelColors.ts`, which has been hex rather than a palette token since
    /// 2026-08-20.
    ///
    /// **Read only when the row has to be made.** [`crate::deck_meta::valid_color`]'s single
    /// check (non-empty) is all this is held to, because picking what a colour *is* belongs to
    /// the webview — CLAUDE.md's Rust/TS boundary, and the reason this column carries no CHECK.
    ///
    /// Required whenever [`Self::label_name`] is present: `deck_labels.color` is `NOT NULL`. A name
    /// with no colour beside it is refused rather than defaulted, because a default here would be
    /// this module deciding what a colour is.
    #[serde(default)]
    pub label_color: Option<String>,
}

/// What an import did, in the three numbers the "Imported 117 cards" report is written from.
///
/// [`Self::added`] and [`Self::removed`] are **copies**, not rows — a reader counts cards — and
/// `added` is what the list asked for rather than what the deck landed on, so a merge that
/// folded 3 onto an existing 2 reports 3. [`Self::categories_created`] is the piles the import
/// had to make, which is the part of the outcome a reader could not have predicted from the
/// file: a section name their deck already had costs nothing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub added: i64,
    pub removed: i64,
    pub categories_created: i64,
    /// The `deck_labels` rows the import had to make — [`Self::categories_created`]'s question one
    /// table over, and owed for a sharper reason: a label is **app-wide** since schema v21, so an
    /// import that invents three has changed a list every other deck reads from. A label the
    /// reader already had is used and not counted.
    pub labels_created: i64,
}

/// The `deck_labels` row one imported label means: the one that is already there, or a new one in
/// the colour the file asked for.
///
/// **Find-or-create, and the found half never changes anything** — not the name's capitals, not
/// the colour, not `updated_at`. That is the reader's instruction stated as a function: a label
/// they already own is a decision they made, and a decklist naming the same word is not a request
/// to repaint it. It matters more here than the same rule does for a category, because a label is
/// app-wide since schema v21: recolouring one would recolour it in every deck they have.
///
/// `seen` memoises within the list, keyed on [`crate::schema::label_name_key`]'s answer, so a
/// hundred lines wearing `Keeper` cost one lookup and one creation — and, just as importantly,
/// count as **one** in `created`.
///
/// **Deliberately not [`crate::deck_meta::create_label`]**, which is the right function for a
/// reader pressing a button and the wrong one here: it opens a transaction of its own, refuses a
/// name that is taken (which is the ordinary case for an import, not an error), writes its own
/// `deck_audit` row and records its own undo step. This import is one transaction, one history
/// row and one step; a hundred labels must not be a hundred of each.
fn label_for_name(
    tx: &Connection,
    name: &str,
    color: Option<&str>,
    seen: &mut HashMap<String, i64>,
    created: &mut i64,
) -> Result<i64, String> {
    let name = crate::deck_meta::valid_name(name, "A label")?;
    let key = crate::schema::label_name_key(name);
    if let Some(id) = seen.get(&key) {
        return Ok(*id);
    }
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM deck_labels WHERE name_key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let id = match existing {
        Some(id) => id,
        None => {
            // Refused rather than defaulted: `deck_labels.color` is NOT NULL and what a colour
            // *is* belongs to the webview, so a name arriving with no colour beside it is a
            // caller bug and not a shape this module may paper over.
            let color = crate::deck_meta::valid_color(color.unwrap_or(""))?;
            *created += 1;
            tx.query_row(
                "INSERT INTO deck_labels (name, name_key, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
                 RETURNING id",
                params![name, key, color],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?
        }
    };
    seen.insert(key, id);
    Ok(id)
}

/// A whole decklist into one deck, in one transaction.
///
/// **This command existed for the allocator, and outlives it.** Looping
/// [`crate::deck::add_card`] from the frontend would have run `allocate_deck` once per line — a
/// hundred rebuilds of a deck's claims for one import, each deleting and re-deriving every row
/// the last one wrote — and this command ran it once, at the end, over the finished deck.
/// Schema v25 dropped the allocator, and what is left is the reason that survives it: **one
/// transaction**. A hundred `add_card` calls are a hundred transactions, so a list that is
/// refused on line 90 leaves 89 cards in the deck and a history of 89 edits nobody made.
///
/// Everything else is [`crate::deck::add_card`]'s shape held to deliberately: the same two
/// opening fences (a variant the schema knows, a deck that is still there), the same
/// [`crate::schema::DECK_CARD_GRAIN`] `ON CONFLICT` fold, the same
/// [`crate::deck_meta::category_for_name`] find-or-create, and the same
/// [`crate::deck_audit::record`] call *inside* the caller's transaction. What it does not
/// borrow is `add_card` itself — that is the whole point.
///
/// Four decisions worth stating, because each is a thing that would be wrong the other way:
///
/// * **`replace` clears the cards and leaves the categories.** A category is the reader's
///   filing, not the list's; a replace that swept them would delete piles somebody named,
///   reordered and switched off, to import a file that mentions none of that.
/// * **It clears one variant.** `theory` is a plan and `live` is what is sleeved up, and
///   replacing one must never touch the other — the reason `variant` is in the grain at all.
/// * **The history is one row per *effect*, never one per card.** An import of 117 cards would
///   put 117 rows in the drawer and bury every other event of that day. So: an `add` row
///   carrying the counts, plus — in `replace`, and only when something was actually cleared —
///   a `remove` row. Neither names a card, because no one card is what happened. This is the
///   shape `deck_update` already uses (one row per changed field), and it needs no new
///   [`crate::schema::AUDIT_KINDS`] value and so no migration.
/// * **The copies behind a replaced `live` list come back.** They are filed into
///   `Recently removed` before the clear, through [`crate::deck::release_live_copies`] — a
///   `deck_cards` row is an intention and a row in the deck's group is cardboard the reader
///   physically owns, so replacing the list is not a reason to stop owning it. What the reader
///   sees is worth saying plainly rather than leaving to be discovered: **an import in replace
///   mode leaves the freshly imported rows owning nothing**, every owned count at zero, until
///   the copies are filed back out of `Recently removed`. That is exactly where
///   `Clear live list…` leaves them — [`crate::deck::clear_variant`] runs the identical DELETE
///   and reached the identical conclusion — and it is the price of the copies being findable at
///   all: the alternative is not that they stay in the deck, it is that they stay filed under a
///   list that has never heard of them, invisible on the Collection page and unavailable to
///   every other deck. Wrong the other way is
///   [issue #336](https://github.com/Msgaihede/mtg-grimoire/issues/336), which is how this arm
///   behaved until it was closed.
///
/// **This is a *deck* import and writes no [`crate::activity`] row** — one event, one line: it
/// records `deck_audit` rows, which `activity::recent` reads straight out of that table and puts
/// in the same feed. The `collection_entries` writes it can reach are
/// [`crate::deck::release_live_copies`]', a consequence of the clear this press already logged.
/// A **collection** or **wishlist** file goes to `collection::commit_import` /
/// `wishlist::commit_import` instead, and each of those records its own single `import` row.
pub fn commit_import(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    mode: &str,
    items: &[ImportItem],
) -> Result<ImportOutcome, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    if !IMPORT_MODES.contains(&mode) {
        return Err(format!(
            "`{mode}` is not an import mode. Use one of: {}.",
            IMPORT_MODES.join(", ")
        ));
    }
    if items.is_empty() {
        return Err(NOTHING_TO_IMPORT.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;

    // The undo step's two "before" halves, read ahead of everything this command writes: the
    // list as it stood, and which piles the deck already had, so a `replace` can be put back
    // and the piles this import invents can be taken away with it. Both are one query and this
    // command already reads the whole variant to count what it is about to clear.
    let cards_before = crate::deck_undo::read_variant(&tx, deck_id, variant)?;
    let categories_before = crate::deck_undo::category_ids(&tx, deck_id)?;
    // The third "before", read for the piles' reason and answering about a table with no deck in
    // it: `deck_labels` is app-wide since schema v21, so this is every label there is, and the
    // step sweeps whichever ones this import turns out to have invented.
    let labels_before = crate::deck_undo::label_ids(&tx)?;

    // **Copies, not rows.** `removed` becomes the `remove` row's `delta`, and that column is
    // signed *copies* — the number the day header adds up and the number a reader recognises.
    let removed: i64 = if mode == REPLACE {
        let cleared: i64 = tx
            .query_row(
                "SELECT coalesce(sum(quantity), 0) FROM deck_cards
                  WHERE deck_id = ?1 AND variant = ?2",
                params![deck_id, variant],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        // **The copies behind the list this is about to delete come back.** A `deck_cards` row
        // is an intention; a row in the deck's **group** is cardboard the reader physically
        // owns, and importing over a list does not stop them owning it. So every copy the group
        // holds behind a `live` row is filed into `Recently removed` first, through
        // [`crate::deck::release_live_copies`] — before the DELETE, because those rows are what
        // say which printings and how many, and inside this transaction, so a refused import has
        // moved no card.
        //
        // This is the line that was missing until issue #336. [`crate::deck::clear_variant`]
        // runs the identical DELETE for the identical reason, and had released since it was
        // written; this arm had the DELETE and not the release, so importing over a live list
        // left every copy filed under a deck with no row naming it — invisible on the Collection
        // page since schema v25, and unavailable to every other deck. The two agree now, and the
        // fence is `release_live_copies`' own: a `theory` replace releases nothing, because a
        // plan holds no cards.
        crate::deck::release_live_copies(&tx, deck_id, variant, None)?;
        tx.execute(
            "DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2",
            params![deck_id, variant],
        )
        .map_err(|e| e.to_string())?;
        cleared
    } else {
        0
    };

    // Keyed on the **trimmed** name, which is the form `category_for_name` stores and therefore
    // the form two lines have to agree on: `Ramp` and `  Ramp  ` are one pile in the database,
    // and a map keyed on the raw string would count them as two categories in the history row.
    let mut categories: HashMap<&str, i64> = HashMap::new();
    let mut categories_created = 0i64;
    // Keyed on `label_name_key`'s answer rather than on the word, because that is what
    // `deck_labels.name_key`'s UNIQUE index means by "the same label" — a list writing `Keeper` on
    // one line and `keeper` on the next must not ask the database twice and must not count two
    // creations. A `HashMap` and not SQL for `merge_label_rows`' reason one file over: no SQLite
    // build in this app can compute that key.
    let mut labels: HashMap<String, i64> = HashMap::new();
    let mut labels_created = 0i64;
    let mut added = 0i64;
    {
        // Prepared once for the whole list rather than per line — the one place a 117-line
        // import would otherwise pay 117 compilations of the same statement.
        //
        // **`label_id` coalesces where `quantity` sums**, and the asymmetry is the whole of what a
        // `merge` promises: two copies of a card are three copies of a card, but a label the
        // reader put on a row by hand is a decision this import may not overturn. So an existing
        // row keeps its label and a row that has none takes the file's — which also means the
        // second of two items landing on one grain cannot repaint the first.
        let sql = format!(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
                 finish, quantity, label_id, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, unixepoch(), unixepoch())
             ON CONFLICT({grain}) DO UPDATE SET
                quantity = deck_cards.quantity + excluded.quantity,
                label_id = coalesce(deck_cards.label_id, excluded.label_id),
                updated_at = unixepoch()",
            grain = crate::schema::DECK_CARD_GRAIN
        );
        let mut insert = tx.prepare(&sql).map_err(|e| e.to_string())?;
        for item in items {
            // Before anything is created for this line: a refusal rolls the transaction back
            // anyway, but there is no reason to make a category for a line that cannot land.
            if item.quantity <= 0 {
                return Err(crate::collection::ZERO_ADD.to_owned());
            }
            let category_name = item.category_name.trim();
            let category_id = match categories.get(category_name) {
                Some(id) => *id,
                None => {
                    // Asked *before* the find-or-create, because afterwards there is no way to
                    // tell a category that was made from one that was already there — and "3
                    // new categories" is a sentence the preview promises.
                    //
                    // **In the list being imported into**, as the find-or-create below is (user
                    // schema v53): an import onto the Theory tab files into the plan's piles, so
                    // a `Ramp` only the live list has is a pile this import makes.
                    let existed = tx
                        .query_row(
                            "SELECT 1 FROM deck_categories
                              WHERE deck_id = ?1 AND variant = ?2 AND name = ?3",
                            params![deck_id, variant, category_name],
                            |_| Ok(()),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    // Creates a `kind = 'main'` category, and matches the four predefined ones
                    // **by name** — so a `Sideboard` line lands on the seeded `side` row and
                    // nothing is made. See `category_for_name`'s doc for why the lookup cannot
                    // be narrowed to `main`.
                    let id =
                        crate::deck_meta::category_for_name(&tx, deck_id, variant, category_name)?;
                    if existed.is_none() && item.inactive {
                        // Straight to the column rather than through `deck_meta::set_category_active`:
                        // that one opens a transaction of its own, writes a history row and
                        // reallocates, and all three are already this function's — the allocator
                        // runs once at the end, over the finished deck.
                        tx.execute(
                            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
                            params![id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    if existed.is_none() {
                        categories_created += 1;
                    }
                    categories.insert(category_name, id);
                    id
                }
            };
            let (set_code, collector_number, lang, name) =
                crate::deck::printing_of(&tx, &item.card_id)?;
            // Through the one normaliser, like every other write: a line marked `*F*` is a foil
            // row, and one marked nothing is the regular copy. **Not checked against
            // `cards.finishes`** — unlike `set_card_finish`, which is a reader pointing at a
            // control this app drew. This is somebody else's export, and refusing a whole
            // 117-line import because one line claims a foil the corpus does not list would
            // cost the reader their paste over a fact about a marker.
            let finish = crate::deck::normalise_finish(item.finish.as_deref())?;
            let label_id = match item.label_name.as_deref() {
                None => None,
                Some(label) => Some(label_for_name(
                    &tx,
                    label,
                    item.label_color.as_deref(),
                    &mut labels,
                    &mut labels_created,
                )?),
            };
            insert
                .execute(params![
                    deck_id,
                    category_id,
                    variant,
                    item.card_id,
                    set_code,
                    collector_number,
                    lang,
                    name,
                    finish,
                    item.quantity,
                    label_id
                ])
                .map_err(|e| e.to_string())?;
            // Saturating because `quantity` is an `i64` off the wire and this is the one place
            // the values are summed; an overflow panic in a debug build would be a stranger
            // failure than a number no deck can hold.
            added = added.saturating_add(item.quantity);
        }
    }

    // Facts only — `auditText.ts` words them. `None` for the card because an import is about no
    // one card, and the counts are what a reader is owed instead.
    if removed > 0 {
        crate::deck_audit::record(
            &tx,
            deck_id,
            variant,
            crate::deck_audit::REMOVE,
            None,
            &json!({ "import": { "mode": mode, "cleared": removed } }),
            -removed,
        )?;
    }
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::ADD,
        None,
        &json!({
            "import": {
                "mode": mode,
                "lines": items.len(),
                "cards": added,
                "categories": categories.len(),
                // The labels this import **made**, not the ones it used: a label the reader
                // already had is not news, and this row is app-wide news. `auditText.ts` words
                // it, and reads an absent key as none — every row written before today.
                "labelsCreated": labels_created,
            }
        }),
        added,
    )?;
    // **One step for the whole import, keyed to the `add` row** — the last of the one or two
    // this writes. A `replace` records a `remove` and an `add` because one signed delta cannot
    // be both, but it is one press, and a cursor that could land between them would put the
    // cleared deck back without the import that replaced it. `record_variant` is the whole
    // reversal: the audit rows carry counts (`cleared: 42`, `cards: 117`) and a count cannot
    // rebuild a decklist.
    crate::deck_undo::record_variant(
        &tx,
        audit_id,
        deck_id,
        variant,
        cards_before,
        Some(categories_before),
        Some(labels_before),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportOutcome {
        added,
        removed,
        categories_created,
        labels_created,
    })
}

/// A decklist into a deck: one transaction, one allocation, one or two history rows.
///
/// The **write** connection through [`crate::sync::with_write`], answering [`crate::db::BUSY`]
/// if it cannot be had.
#[tauri::command]
pub async fn deck_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
    mode: String,
    items: Vec<ImportItem>,
) -> Result<ImportOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write`, and still plain now that a `live` replace writes
        // `collection_entries`.** The release moves rows *between folders* and folds some of
        // them away; `with_write_owned`'s whole extra step is the facet index's `owned`
        // dimension, which is folder-blind, so no card enters or leaves the reader's ownership
        // here and rebuilding it would read the collection to arrive at the answer it holds.
        // The argument in full is on `deck::release_live_copies`.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        crate::sync::with_write(&state, |conn| {
            commit_import(conn, deck_id, &variant, &mode, &items)
        })
    })
    .await
    .map_err(|e| format!("the decklist could not be imported: {e}"))?
}

/// A decklist file the reader picked, as text.
///
/// **It takes a path, not bytes** — the page asks the OS for a name and Rust opens the file,
/// which is the same contract [`crate::export::export_write_file`] uses in the other direction
/// and the whole reason `dialog:allow-open` is sufficient and **no `fs:` permission is granted
/// anywhere**. (`deck_set_cover_image` was the third command on this contract and the one that
/// established it; custom deck covers went on 2026-08-31 and took it with them.) A
/// webview that could read a file itself would need one; a webview that can only name a file
/// needs none.
///
/// Two decisions, and each is a thing that would be wrong the other way:
///
/// * **The size is bounded by how much is read, not by `metadata()`.** [`MAX_IMPORT_BYTES`] is a
///   fence rather than a truncation — a 200 MB file the reader pointed at by mistake costs one
///   megabyte to refuse rather than two hundred. It is the same constant the paste path uses, so
///   the two cannot disagree about how long a decklist may be.
/// * **The bytes are never refused and never decoded lossily** — see [`decode`], and
///   [`FileEncoding`] for which reading the page is told about. This used to be
///   `from_utf8_lossy`, on the argument that a Windows-1252 apostrophe should cost one line
///   rather than the whole file. The first half of that stands; the lossy half was wrong
///   (issue #555), because the file that carries one cp1252 byte is Excel's "CSV" on a Western
///   European Windows, and it carries **every** accented name in that code page — `Jötun Grunt`,
///   `Séance`, `Lim-Dûl's Vault` each turned into `U+FFFD` and each quoted back as unmatched,
///   while the byte that said which character it was sat one table lookup away.
fn read_import_file(path: &str) -> Result<ImportFile, String> {
    std::fs::File::open(path)
        .map_err(|e| open_failed(format!("could not open {path}: {e}")))
        .and_then(read_bounded)
}

/// What a source this app cannot open says, keeping the OS's own reason — `not found` and
/// `access denied` are different things for the reader to do something about, and dropping the
/// tail would make them the same message.
fn open_failed(e: String) -> String {
    format!("That file could not be opened — {e}")
}

/// The cap and the decode, over anything readable.
fn read_bounded(mut reader: impl std::io::Read) -> Result<ImportFile, String> {
    use std::io::Read as _;

    // **A bounded read rather than a `metadata()` check.** `take(MAX + 1)` then a length test is
    // the whole of it — one byte over the limit is read and refused, and nothing larger is ever
    // in memory, which keeps what the fence was for: a 200 MB file the reader pointed at by
    // mistake costs a megabyte, not two hundred.
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("That file could not be read — {e}"))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "That file is over {} MB. A decklist is text; this reads at most 1 MB.",
            MAX_IMPORT_BYTES / 1_000_000
        ));
    }
    Ok(decode(&bytes))
}

/// How a picked file's bytes were turned into text — `ImportFile.encoding` in `src/lib/ipc.ts`,
/// whose four strings are these four `rename`s exactly.
///
/// **The page is told, because one of the four is a guess.** A byte-order mark *names* UTF-16
/// and a file that validates as UTF-8 is UTF-8 beyond reasonable doubt (a legacy code page almost
/// never produces a valid multi-byte sequence by accident), so three of these are facts about the
/// file. [`Self::Windows1252`] is the fallback for everything else, and it is only right for a
/// file saved in *that* code page: a Central European or Cyrillic one decodes without complaint
/// into the wrong letters, and nothing on this side can tell. The reader can — so the import
/// dialog says which reading it took, and only for this one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "windows-1252")]
    Windows1252,
}

/// A decklist file, as text, and the reading that produced it (issue #555).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub text: String,
    pub encoding: FileEncoding,
}

/// Windows-1252's `0x80`–`0x9F`, the only 32 bytes where it is not Latin-1.
///
/// **Hand-written rather than `encoding_rs`**, for [`fold_name`]'s reason: the table is 32
/// entries, fixed since 1998, and a crate added for one lookup is a crate to keep. Below `0x80`
/// the code page is ASCII and from `0xA0` up it is Latin-1, so both are `char::from(byte)` and
/// need no table at all.
///
/// **The five bytes the code page leaves undefined — `0x81`, `0x8D`, `0x8F`, `0x90`, `0x9D` —
/// map to the C1 control of the same number**, which is WHATWG's rule for `windows-1252` and what
/// every browser does. The alternative, `U+FFFD`, would make this decode lossy in exactly the
/// case it exists to stop being lossy in; a C1 control is invisible, matches no card name, and
/// keeps the byte recoverable.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

/// One byte of Windows-1252, as the character it stands for. Total: every byte has an answer.
fn cp1252(byte: u8) -> char {
    match byte {
        0x80..=0x9F => CP1252_HIGH[usize::from(byte - 0x80)],
        _ => char::from(byte),
    }
}

/// UTF-16 code units out of byte pairs, in the order a byte-order mark named. A trailing odd
/// byte cannot be half a character and becomes one `U+FFFD`, and so does an unpaired surrogate
/// (`from_utf16_lossy`'s own rule) — a UTF-16 file that is damaged is the one case here where a
/// replacement character is the honest answer, because there is no byte to recover.
fn utf16(body: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let (pairs, odd) = body.as_chunks::<2>();
    let units: Vec<u16> = pairs.iter().copied().map(unit).collect();
    let mut text = String::from_utf16_lossy(&units);
    if !odd.is_empty() {
        text.push(char::REPLACEMENT_CHARACTER);
    }
    text
}

/// A file's bytes as text, **never refused and never lossy for a Western European file** — the
/// order is the whole of it, and each step is only reached when the one above could not answer:
///
/// 1. **A UTF-8 byte-order mark** is stripped and the rest read as UTF-8. Notepad and Excel's
///    "CSV UTF-8" both write one, and left in it glues `U+FEFF` to the front of the first line —
///    a CSV header whose first cell no longer says `Quantity`. The mark is a statement, so a
///    malformed byte *after* it is taken as damage (`U+FFFD`) rather than as a reason to disbelieve
///    the mark.
/// 2. **A UTF-16 mark**, `FF FE` or `FE FF`, which is what Windows' "Unicode" save writes. Neither
///    pair can open valid UTF-8, so this cannot shadow step 3.
/// 3. **Valid UTF-8** is UTF-8. Every file this app writes lands here.
/// 4. **Anything else is Windows-1252** — see [`FileEncoding::Windows1252`] for why the page is
///    told. Every byte decodes to exactly one character, so no line is ever lost to a byte.
///
/// A UTF-16 file with **no** mark is not detected: it validates as UTF-8 full of `NUL`s and reads
/// as a list that matches nothing. Windows' own tools always write the mark, and guessing byte
/// order from the pattern of zeros is a heuristic this was not asked to carry.
fn decode(bytes: &[u8]) -> ImportFile {
    let (text, encoding) = if let Some(body) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        (
            String::from_utf8_lossy(body).into_owned(),
            FileEncoding::Utf8,
        )
    } else if let Some(body) = bytes.strip_prefix(b"\xFF\xFE") {
        (utf16(body, u16::from_le_bytes), FileEncoding::Utf16Le)
    } else if let Some(body) = bytes.strip_prefix(b"\xFE\xFF") {
        (utf16(body, u16::from_be_bytes), FileEncoding::Utf16Be)
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        (text.to_owned(), FileEncoding::Utf8)
    } else {
        (
            bytes.iter().copied().map(cp1252).collect(),
            FileEncoding::Windows1252,
        )
    };
    ImportFile { text, encoding }
}

/// Read a decklist file the reader picked, and hand the text to the parser.
///
/// **The one command in this module that takes no state**: it touches no database, so it needs
/// neither connection and cannot be refused as [`crate::db::BUSY`]. What comes back is
/// text, and everything after it — the lines, the quantities, the sections — is TypeScript's,
/// exactly as it is for a paste. That is the whole reason this is a *read* and not an import:
/// a file and a paste become the same string here and travel the same path afterwards.
///
/// On the blocking pool like its two siblings, because a file on a network share or a slow
/// stick is a disk wait, and the async runtime is not where a disk wait belongs.
///
/// It answers the reading beside the text ([`ImportFile::encoding`]) so the dialog can say when
/// a file was not UTF-8 — which a bare string could never tell it.
#[tauri::command]
pub async fn import_read_file(path: String) -> Result<ImportFile, String> {
    tauri::async_runtime::spawn_blocking(move || read_import_file(&path))
        .await
        .map_err(|e| format!("the decklist file could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Twelve printings, shaped around the questions this module has to answer.
    ///
    /// Five **paper** Sol Rings and one digital one, because every ordering rule needs more
    /// than one printing of a name to order and `printing_count` needs a digital printing to
    /// leave out. `40k` and `clb` are given the **same** `released_at` deliberately — the real
    /// corpus is full of sets that share a release date, and without a tie the `id` tie-break
    /// that makes an import deterministic has nothing to break.
    ///
    /// **`sol-ja` is the newest paper Sol Ring and it is Japanese**, which is the shape
    /// [`MATCH_ORDER`]'s language term exists for: 5 of the reference list's 105 lines landed
    /// on a `ja`/`dw`/`ph` printing for exactly this reason. It is deliberately newer than
    /// every English one, so the date key alone would choose it.
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
        let conn = crate::schema::memory_pair();
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
                 ('sol-ja','o-sol','Sol Ring','sjr','1','ja','2023-05-01',1,'normal',
                  'uncommon','{1}',1.0,'Artifact','{T}: Add {C}{C}.','','',
                  '{"vintage":"restricted","commander":"legal"}',NULL,NULL,
                  '{"usd":"4.25"}','{}'),
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
            lang: None,
        }
    }

    /// A line carrying a set, and optionally a collector number.
    fn hinted(name: &str, set_code: &str, collector_number: Option<&str>) -> ResolveLine {
        ResolveLine {
            name: name.to_owned(),
            set_code: Some(set_code.to_owned()),
            collector_number: collector_number.map(str::to_owned),
            lang: None,
        }
    }

    /// Any line, saying which language its copy is in — what a collection CSV's `Language`
    /// column becomes once `languageCode` has read it.
    fn in_lang(l: ResolveLine, lang: &str) -> ResolveLine {
        ResolveLine {
            lang: Some(lang.to_owned()),
            ..l
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

    /// One collection row, at the plainest grain there is — [`crate::deck`]'s test helper,
    /// answering the row's id as that one does so [`file_into_group`] can go on and re-file it.
    fn own(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id
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

    /// The date key, with the language term settled above it: `sol-ja` is newer than every
    /// English printing and must not win, and among the English ones the two that share
    /// 2022-10-07 are separated by the id.
    #[test]
    fn with_nothing_owned_the_newest_english_paper_printing_wins() {
        let conn = seeded();
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.card_id, "sol-clb",
            "2022-10-07, and `clb` > `40k` on the id — not `sol-ja`, which is newer and Japanese"
        );
        assert_eq!(m.owned_quantity, 0);
    }

    /// **The language term's position, which is the half of it that had to be decided.** A
    /// copy you own in any language is still a copy you own — the whole promise of the first
    /// key is that a list you have the cards for puts *your* copies in the deck, and an
    /// English printing you have not got claims nothing from the binder.
    #[test]
    fn a_printing_you_own_outranks_the_language_preference() {
        let conn = seeded();
        own(&conn, "sol-ja", 2);
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.card_id, "sol-ja",
            "owned beats English, and English beats newest"
        );
        assert_eq!(m.owned_quantity, 2);
    }

    /// The fold arm re-implements [`MATCH_ORDER`] in Rust and may never disagree with it, so
    /// every key it carries needs pinning there too. Lower-casing is what routes a line through
    /// that arm at all, now that the SQL arms are binary.
    #[test]
    fn the_fold_arm_prefers_english_as_well() {
        let conn = seeded();
        assert_eq!(matched_id(&conn, line("sol ring")), "sol-clb");
        // And the same key sits behind `owned_quantity` there as it does in the SQL.
        own(&conn, "sol-ja", 1);
        assert_eq!(matched_id(&conn, line("sol ring")), "sol-ja");
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

    /// **The bug the live pass found: `1 Captain Sisay (brc) 132` imported Arcane Signet.**
    ///
    /// `brc` 132 is a real printing and it is a different card, so the hint neither missed nor
    /// named what the reader asked for — and with no name check the preview drew no problem at
    /// all. Here `c21` 263 is Sol Ring and the line says Jötun Grunt; against the code before
    /// the guard this test resolves to `sol-c21` with `hint_missed: false`.
    ///
    /// The fall-through is the second half of the claim: discarding the hint must cost the
    /// reader the *printing*, never the card.
    #[test]
    fn a_hint_that_names_a_different_card_is_discarded_and_reported() {
        let conn = seeded();

        let row = resolve_one(&conn, hinted("Jotun Grunt", "c21", Some("263")));

        assert!(
            row.hint_missed,
            "the hint resolved, but not to the card the line named"
        );
        assert_eq!(
            row.matched.unwrap().card_id,
            "jotun",
            "and the name rules answered anyway — a wrong hint costs the printing, not the card"
        );
    }

    /// The guard must be as permissive as the name arms it stands in for, or it would refuse
    /// hints those arms would have honoured. Three shapes, one per arm:
    ///
    /// * the whole name, exactly — [`BY_NAME`];
    /// * the **front face** of a `"A // B"` printing — [`BY_FRONT_FACE`], and the shape a
    ///   naive `card.name == wanted` guard would break, since every DFC in every decklist is
    ///   written this way;
    /// * a **folded** name — [`fold_match`]'s rule, which is what `Jotun` for `Jötun` needs.
    ///
    /// And a line that gave only a printing gave no name to disagree with.
    #[test]
    fn a_hint_naming_the_card_by_a_front_face_or_a_fold_is_still_honoured() {
        let conn = seeded();

        let exact = resolve_one(&conn, hinted("Sol Ring", "c21", Some("263")));
        assert!(!exact.hint_missed);
        assert_eq!(exact.matched.unwrap().card_id, "sol-c21");

        let front = resolve_one(&conn, hinted("Kolvori, God of Kinship", "khm", Some("216")));
        assert!(
            !front.hint_missed,
            "the printing is `Kolvori … // The Ringhart Crest`"
        );
        assert_eq!(front.matched.unwrap().card_id, "kolvori");

        let folded = resolve_one(&conn, hinted("Jotun Grunt", "csp", Some("8")));
        assert!(!folded.hint_missed, "the printing is `Jötun Grunt`");
        assert_eq!(folded.matched.unwrap().card_id, "jotun");

        let nameless = resolve_one(
            &conn,
            ResolveLine {
                name: String::new(),
                set_code: Some("c21".to_owned()),
                collector_number: Some("263".to_owned()),
                lang: None,
            },
        );
        assert!(!nameless.hint_missed, "there was no name to contradict");
        assert_eq!(nameless.matched.unwrap().card_id, "sol-c21");
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
            the_old_hole, 10,
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
                lang: None,
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
                lang: None,
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

    // ------------------------------------------------------------------------------------
    // the language preference (issue #555)
    // ------------------------------------------------------------------------------------

    /// The whole feature in two lines: a Sol Ring the file says is Japanese is the Japanese
    /// printing, and one it says nothing about is the one it always was — `sol-ja` is the newest
    /// paper Sol Ring and still loses to `sol-clb` without the preference.
    #[test]
    fn a_line_that_says_japanese_lands_on_the_japanese_printing() {
        let conn = seeded();
        assert_eq!(matched_id(&conn, in_lang(line("Sol Ring"), "ja")), "sol-ja");
        assert_eq!(
            matched_id(&conn, line("Sol Ring")),
            "sol-clb",
            "and a line that says nothing is today's winner"
        );
    }

    /// **The position, which is the half that had to be decided.** The file's word outranks the
    /// binder's: a Japanese line is a Japanese copy even when the reader owns an English one, and
    /// an English line is an English copy even when the only one they own is Japanese. Within the
    /// asked language the owned printing still wins, so the binder breaks the tie it always did.
    #[test]
    fn the_language_the_file_names_outranks_the_printing_you_own() {
        let conn = seeded();
        own(&conn, "sol-lea", 1);
        assert_eq!(matched_id(&conn, in_lang(line("Sol Ring"), "ja")), "sol-ja");
        assert_eq!(
            matched_id(&conn, in_lang(line("Sol Ring"), "en")),
            "sol-lea",
            "both English, so the owned one wins between them"
        );

        let conn = seeded();
        own(&conn, "sol-ja", 2);
        assert_eq!(
            matched_id(&conn, in_lang(line("Sol Ring"), "en")),
            "sol-clb",
            "the owned Japanese copy is not the English copy the file describes"
        );
        assert_eq!(
            matched_id(&conn, line("Sol Ring")),
            "sol-ja",
            "and a line that says nothing still takes the copy you own"
        );
    }

    /// **A preference, never a filter.** No German Sol Ring exists, so a German line resolves
    /// exactly as a silent one does — and `printing_count` is a window over every matched row, so
    /// it does not narrow to the language either.
    #[test]
    fn a_language_no_printing_is_in_changes_nothing() {
        let conn = seeded();
        let m = resolve_one(&conn, in_lang(line("Sol Ring"), "de"))
            .matched
            .expect("a preference cannot cost the card");
        assert_eq!(m.card_id, "sol-clb");
        assert_eq!(
            m.printing_count, 5,
            "all five paper printings, not the German ones"
        );
    }

    /// [`preferred_lang`] is the fence that makes the SQL literal safe, so it is pinned value by
    /// value: two or three ASCII letters after a trim and a lowercase, and nothing else — and a
    /// value it refuses is **ignored**, never an error and never a miss.
    #[test]
    fn a_language_that_is_not_a_code_is_ignored_rather_than_refused() {
        let accepted = |raw: &str| preferred_lang(&Some(raw.to_owned()));
        assert_eq!(accepted("ja"), Some("ja".to_owned()));
        assert_eq!(accepted(" ZHS "), Some("zhs".to_owned()));
        assert_eq!(accepted("Japanese"), None);
        assert_eq!(accepted("ja-JP"), None);
        assert_eq!(accepted("j"), None);
        assert_eq!(accepted(""), None);
        assert_eq!(
            accepted("ja') DESC, (1"),
            None,
            "nothing that can close a quote passes"
        );
        assert_eq!(accepted("jé"), None, "ASCII letters only");
        assert_eq!(preferred_lang(&None), None);

        let conn = seeded();
        for raw in ["Japanese", "ja' OR '1'='1", "   "] {
            assert_eq!(
                matched_id(&conn, in_lang(line("Sol Ring"), raw)),
                "sol-clb",
                "`{raw}` is no preference, so the line resolves as a silent one does"
            );
        }
        assert_eq!(matched_id(&conn, in_lang(line("Sol Ring"), "JA")), "sol-ja");
    }

    /// With nothing to prefer the ordering is **byte for byte** today's — the same string, so the
    /// same plan and the same winner on every list that carries no language.
    #[test]
    fn with_no_language_the_ordering_is_exactly_match_order() {
        assert_eq!(match_order(None), MATCH_ORDER);
        let ja = match_order(Some("ja"));
        assert!(
            ja.starts_with(" ORDER BY (c.lang = 'ja') DESC, owned_quantity DESC,"),
            "the preference goes ahead of every key MATCH_ORDER has: {ja}"
        );
        assert!(ja.ends_with("c.id DESC"), "{ja}");
    }

    /// [`fold_match`] orders in Rust and its `LIMIT` in SQL, and both have to carry the key.
    /// Lower-casing is what routes a line through that arm.
    #[test]
    fn the_fold_arm_prefers_the_language_too() {
        let conn = seeded();
        assert_eq!(matched_id(&conn, in_lang(line("sol ring"), "ja")), "sol-ja");
        own(&conn, "sol-lea", 1);
        assert_eq!(
            matched_id(&conn, in_lang(line("sol ring"), "ja")),
            "sol-ja",
            "ahead of the owned printing there as in the SQL"
        );
        assert_eq!(matched_id(&conn, line("sol ring")), "sol-lea");
    }

    /// The set-scoped arms carry the key too — a set can hold one card in two languages, and a
    /// line naming the set and the language wants the one it described.
    #[test]
    fn a_set_hint_and_a_language_narrow_together() {
        let conn = seeded();
        conn.execute_batch(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                                released_at, is_paper, layout, rarity, raw)
             VALUES ('sol-c21-de', 'o-sol', 'Sol Ring', 'c21', '263', 'de', '2021-04-23', 1,
                     'normal', 'uncommon', '{}');",
        )
        .unwrap();
        assert_eq!(
            matched_id(&conn, in_lang(hinted("Sol Ring", "c21", None), "de")),
            "sol-c21-de"
        );
        assert_eq!(
            matched_id(&conn, in_lang(hinted("Sol Ring", "c21", Some("263")), "de")),
            "sol-c21-de",
            "a set and a number naming two rows is the language's to settle"
        );
        assert_eq!(
            matched_id(&conn, hinted("Sol Ring", "c21", None)),
            "sol-c21",
            "and English first when the line says nothing"
        );
    }

    /// One list, several languages: each distinct language gets its own statements and every
    /// line asking for it reuses them, so neither a line's preference nor its absence can leak
    /// into the next line's ordering.
    #[test]
    fn each_line_is_ordered_by_its_own_language() {
        let conn = seeded();
        own(&conn, "sol-ja", 1);
        let rows = resolve_lines(
            &conn,
            &[
                line("Sol Ring"),
                in_lang(line("Sol Ring"), "en"),
                in_lang(line("Sol Ring"), "ja"),
                line("Sol Ring"),
                in_lang(line("Sol Ring"), "en"),
            ],
        )
        .unwrap();
        let ids: Vec<&str> = rows
            .iter()
            .map(|r| r.matched.as_ref().unwrap().card_id.as_str())
            .collect();
        assert_eq!(ids, ["sol-ja", "sol-clb", "sol-ja", "sol-ja", "sol-clb"]);
    }

    // ------------------------------------------------------------------------------------
    // a set hint that is a set's name (issue #555)
    // ------------------------------------------------------------------------------------

    /// The fixture's `sets` rows — `memory_pair` creates the table empty.
    fn name_sets(conn: &Connection, rows: &[(&str, &str)]) {
        for (code, name) in rows {
            conn.execute(
                "INSERT INTO sets (code, name) VALUES (?1, ?2)",
                params![code, name],
            )
            .unwrap();
        }
    }

    /// Deckbox's `Edition` column, and Dragon Shield's: the set named rather than coded. It is
    /// read as that set and then travels exactly as a code would — through the set-and-name arm
    /// alone, and through the set-and-number arm with a number beside it.
    #[test]
    fn a_set_hint_that_is_a_set_name_is_read_as_that_set() {
        let conn = seeded();
        name_sets(
            &conn,
            &[
                ("c21", "Commander 2021"),
                ("clb", "Commander Legends: Battle for Baldur's Gate"),
            ],
        );

        let by_name = resolve_one(&conn, hinted("Sol Ring", "Commander 2021", None));
        assert!(
            !by_name.hint_missed,
            "the set was found, so nothing was missed"
        );
        assert_eq!(by_name.matched.unwrap().card_id, "sol-c21");

        // An older Deckbox file's `Edition` column arrives through the parser's *code* fallback,
        // and the parser upper-cases a code — so the name comes in shouting, and sometimes
        // padded. Both are the same set.
        let shouty = resolve_one(&conn, hinted("Sol Ring", "COMMANDER 2021", Some("263")));
        assert!(!shouty.hint_missed);
        assert_eq!(shouty.matched.unwrap().card_id, "sol-c21");
        let padded = resolve_one(&conn, hinted("Sol Ring", "  COMMANDER   2021 ", None));
        assert!(!padded.hint_missed);
        assert_eq!(padded.matched.unwrap().card_id, "sol-c21");

        // Folded, not merely case-blind: a curly apostrophe is how a re-exported name drifts.
        let curly = resolve_one(
            &conn,
            hinted(
                "Sol Ring",
                "Commander Legends: Battle for Baldur’s Gate",
                None,
            ),
        );
        assert!(!curly.hint_missed);
        assert_eq!(curly.matched.unwrap().card_id, "sol-clb");
    }

    /// **A code always wins**, so no file that worked before can resolve differently: a hint that
    /// is some printing's set code is never looked up as a name, even when another set's name is
    /// spelled that way.
    #[test]
    fn a_real_set_code_is_never_read_as_a_name() {
        let conn = seeded();
        name_sets(&conn, &[("40k", "c21"), ("c21", "Commander 2021")]);
        let row = resolve_one(&conn, hinted("Sol Ring", "C21", None));
        assert!(!row.hint_missed);
        assert_eq!(row.matched.unwrap().card_id, "sol-c21");
    }

    /// Exactly one set, or none: a name two sets share is no hint, and neither is a name no set
    /// has. Both miss **as a hint always missed** — reported, and the name arms answer.
    #[test]
    fn a_set_name_shared_or_unknown_is_a_missed_hint_and_nothing_worse() {
        let conn = seeded();
        name_sets(&conn, &[("c21", "Shared Name"), ("40k", "Shared Name")]);
        for hint in ["Shared Name", "Not A Set At All"] {
            let row = resolve_one(&conn, hinted("Sol Ring", hint, None));
            assert!(row.hint_missed, "`{hint}` names no one set");
            assert_eq!(row.matched.unwrap().card_id, "sol-clb", "`{hint}`");
        }
    }

    /// MTGO's own codes (`MI` for Mirage, where Scryfall says `mir`) and its `116/350` collector
    /// numbers name nothing here as a code *or* as a name — a miss, reported, and the card by its
    /// name, which is exactly what they did before a hint could be a name.
    #[test]
    fn an_mtgo_code_and_number_are_still_a_plain_miss() {
        let conn = seeded();
        name_sets(&conn, &[("c21", "Commander 2021")]);
        let row = resolve_one(&conn, hinted("Sol Ring", "MI", Some("116/350")));
        assert!(row.hint_missed);
        assert_eq!(row.matched.unwrap().card_id, "sol-clb");
    }

    /// `sets` is a second request an ingest can fail, so a database without it reads the names
    /// off `cards.set_name` — every printing carries its set's name, and only this fallback pays
    /// for the scan.
    #[test]
    fn a_database_with_no_sets_reads_set_names_off_its_cards() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET set_name = 'Commander 2021' WHERE set_code = 'c21'",
            [],
        )
        .unwrap();
        let row = resolve_one(&conn, hinted("Sol Ring", "Commander 2021", None));
        assert!(!row.hint_missed);
        assert_eq!(row.matched.unwrap().card_id, "sol-c21");
    }

    /// Two lines naming one set by name, and a third by code: all three land in it, which is the
    /// per-hint answer being reused rather than recomputed differently.
    #[test]
    fn a_set_name_is_answered_once_for_every_line_that_carries_it() {
        let conn = seeded();
        name_sets(&conn, &[("c21", "Commander 2021")]);
        let rows = resolve_lines(
            &conn,
            &[
                hinted("Sol Ring", "Commander 2021", None),
                hinted("Sol Ring", "commander 2021", Some("263")),
                hinted("Sol Ring", "c21", None),
            ],
        )
        .unwrap();
        for row in &rows {
            assert!(!row.hint_missed, "line {}", row.index);
            assert_eq!(row.matched.as_ref().unwrap().card_id, "sol-c21");
        }
    }

    // ------------------------------------------------------------------------------------
    // commit_import
    // ------------------------------------------------------------------------------------

    /// A deck with nothing in it and its four predefined categories seeded — what an import
    /// lands in. `commander` because it is the format an imported list is most often for, and
    /// because it is what makes the `Commander` predefined category interesting.
    fn deck(conn: &Connection) -> i64 {
        crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: "Imported".to_owned(),
                format_key: "commander".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    fn item(card_id: &str, quantity: i64, category_name: &str) -> ImportItem {
        ImportItem {
            card_id: card_id.to_owned(),
            quantity,
            category_name: category_name.to_owned(),
            // An ordinary, counted pile — what an import has always made, and what an absent
            // `inactive` deserialises to. The two tests about `{noDeck}` build their item by
            // hand rather than widen this helper for a flag every other test would pass `false`.
            inactive: false,
            // The regular copy, for the same reason and with the same escape: a test about the
            // `*F*` marker names its own item.
            finish: None,
            // No label, and the same escape again: every test about Archidekt's `^Label,#hex^`
            // builds its own item.
            label_name: None,
            label_color: None,
        }
    }

    /// Everything one variant of this deck holds, as `(card id, category name, copies)`.
    fn cards_in(conn: &Connection, deck_id: i64, variant: &str) -> Vec<(String, String, i64)> {
        conn.prepare(
            "SELECT dc.card_id, cat.name, dc.quantity
               FROM deck_cards dc JOIN deck_categories cat ON cat.id = dc.category_id
              WHERE dc.deck_id = ?1 AND dc.variant = ?2
              ORDER BY cat.name, dc.card_id",
        )
        .unwrap()
        .query_map(params![deck_id, variant], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    }

    /// One deck card, spelled the way `cards_in` answers.
    fn holding(card_id: &str, category: &str, quantity: i64) -> (String, String, i64) {
        (card_id.to_owned(), category.to_owned(), quantity)
    }

    /// This deck's history as `(kind, delta, payload)`, oldest first.
    fn audit(conn: &Connection, deck_id: i64) -> Vec<(String, i64, serde_json::Value)> {
        crate::deck_audit::list(conn, deck_id, 500)
            .unwrap()
            .into_iter()
            .rev()
            .map(|r| {
                (
                    r.kind,
                    r.delta,
                    serde_json::from_str(&r.payload).expect("a payload is JSON"),
                )
            })
            .collect()
    }

    /// One card into one named category, through the ordinary single-card write — so a test
    /// about an import never builds its "before" state with the thing under test.
    fn put(conn: &Connection, deck_id: i64, card_id: &str, category: &str, variant: &str, n: i64) {
        crate::deck::add_card(
            conn,
            deck_id,
            card_id,
            None,
            Some(category),
            variant,
            None,
            n,
        )
        .unwrap();
    }

    /// Forget every history row, so what a test counts afterwards is only what it drove.
    fn clear_history(conn: &Connection) {
        conn.execute("DELETE FROM deck_audit", []).unwrap();
    }

    // The four collection-folder helpers below are [`crate::deck`]'s test module's, ported
    // rather than shared: they are private to a `#[cfg(test)]` module and no `pub(crate)` on a
    // fixture is worth the reach across files. What they answer is what an import in `replace`
    // mode has to be asked about — where the copies behind a cleared `live` list ended up.

    /// The `collection_folders` row that stands for this deck, which [`crate::deck::create_deck`]
    /// makes. Panics rather than creating one: a deck with no group is a broken invariant.
    fn group_of(conn: &Connection, deck_id: i64) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|e| panic!("deck {deck_id} has no collection group: {e}"))
    }

    /// The one holding area `Recently removed`, by id — where a released copy lands.
    fn removed_group(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .expect("every database past v25 has one `removed` folder")
    }

    /// Copies of one printing sitting in one folder — `0` when it holds none. A sum over
    /// `quantity` rather than a row count, because the question is how many *cards* are there.
    fn folder_copies(conn: &Connection, folder: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE folder_id = ?1 AND card_id = ?2",
            params![folder, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One collection row filed into the deck's own group — what "this deck holds this card"
    /// means since schema v25. Written through the app's own pair of writes rather than a
    /// hand-built row, so the grain and the merge are theirs.
    fn file_into_group(conn: &Connection, deck_id: i64, card_id: &str, quantity: i64) {
        let folder = group_of(conn, deck_id);
        let entry = own(conn, card_id, quantity);
        crate::collection_folders::refile_entry(conn, entry, Some(folder)).unwrap();
    }

    #[test]
    fn a_merge_folds_onto_the_grain() {
        let conn = seeded();
        let id = deck(&conn);
        put(&conn, id, "sol-clb", "Main deck", "live", 2);

        let out = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[item("sol-clb", 3, "Main deck")],
        )
        .unwrap();

        assert_eq!(out.added, 3, "the copies the list asked for, not the total");
        assert_eq!(out.removed, 0);
        assert_eq!(out.categories_created, 0, "`Main deck` was already there");
        assert_eq!(
            cards_in(&conn, id, "live"),
            vec![holding("sol-clb", "Main deck", 5)],
            "one row of five, not a second row of three"
        );
    }

    /// A decklist naming the same card on two lines is ordinary — a split of one card across
    /// two sections of the file, or just a list somebody edited twice. The `ON CONFLICT` fold
    /// is what lets TypeScript hand the lines over as it read them, without deduplicating first.
    #[test]
    fn a_list_naming_one_card_twice_lands_as_one_row() {
        let conn = seeded();
        let id = deck(&conn);

        let out = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[item("sol-clb", 2, "Ramp"), item("sol-clb", 3, "Ramp")],
        )
        .unwrap();

        assert_eq!(out.added, 5);
        assert_eq!(
            cards_in(&conn, id, "live"),
            vec![holding("sol-clb", "Ramp", 5)]
        );
    }

    #[test]
    fn a_replace_clears_only_the_variant_it_was_given() {
        let conn = seeded();
        let id = deck(&conn);
        put(&conn, id, "sol-clb", "Main deck", "live", 1);
        put(&conn, id, "kolvori", "Main deck", "live", 1);
        put(&conn, id, "jotun", "Main deck", "live", 2);
        put(&conn, id, "sol-lea", "Main deck", "theory", 1);
        put(&conn, id, "sol-c21", "Main deck", "theory", 1);

        let out = commit_import(
            &conn,
            id,
            "live",
            "replace",
            &[item("sol-40k", 1, "Main deck")],
        )
        .unwrap();

        assert_eq!(out.removed, 4, "copies cleared, not rows");
        assert_eq!(out.added, 1);
        assert_eq!(
            cards_in(&conn, id, "live"),
            vec![holding("sol-40k", "Main deck", 1)]
        );
        assert_eq!(
            cards_in(&conn, id, "theory"),
            vec![
                holding("sol-c21", "Main deck", 1),
                holding("sol-lea", "Main deck", 1),
            ],
            "a plan is not what the reader asked to replace"
        );
    }

    /// A category is the reader's filing, not the list's. A replace that swept them would
    /// delete piles somebody named, reordered and switched off, to import a file that mentions
    /// none of that — and the emptied category is exactly where they will want to put things
    /// back.
    #[test]
    fn a_replace_leaves_the_categories_alone() {
        let conn = seeded();
        let id = deck(&conn);
        let ramp = crate::deck_meta::create_category(&conn, id, "live", "Ramp")
            .unwrap()
            .id;
        crate::deck_meta::set_category_active(&conn, ramp, false).unwrap();
        put(&conn, id, "sol-clb", "Ramp", "live", 1);

        commit_import(
            &conn,
            id,
            "live",
            "replace",
            &[item("jotun", 1, "Main deck")],
        )
        .unwrap();

        let (name, active): (String, bool) = conn
            .query_row(
                "SELECT name, is_active FROM deck_categories WHERE id = ?1",
                params![ramp],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("the category the reader made must still be there");
        assert_eq!(name, "Ramp");
        assert!(!active, "and still switched off");
        assert_eq!(
            cards_in(&conn, id, "live"),
            vec![holding("jotun", "Main deck", 1)],
            "empty, but still a pile"
        );
    }

    #[test]
    fn a_category_the_deck_does_not_have_is_created_once() {
        let conn = seeded();
        let id = deck(&conn);

        let out = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[
                item("sol-clb", 1, "Ramp"),
                item("kolvori", 1, "Ramp"),
                // The same pile written with the whitespace a paste leaves on it. One
                // category, and the count must say one.
                item("jotun", 1, "  Ramp  "),
            ],
        )
        .unwrap();

        assert_eq!(out.categories_created, 1);
        let ramps: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1 AND name = 'Ramp'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ramps, 1);
    }

    /// A `Sideboard` section lands on the seeded `side` category rather than making a second
    /// pile with the same word on it — `category_for_name` looks up by name alone, which is
    /// what `DECK_CATEGORY_GRAIN` (one name per list) requires of it.
    /// A pile the import **creates** for a `{noDeck}` line arrives switched off.
    ///
    /// Archidekt's `{noDeck}` is "counts toward nothing", which is this schema's `is_active = 0`.
    /// Without this the reference deck's 17 maybeboard cards land in a counted pile and a 100-card
    /// commander deck reports 117.
    #[test]
    fn an_import_creates_a_no_deck_pile_switched_off() {
        let conn = seeded();
        let id = deck(&conn);

        commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[ImportItem {
                card_id: "sol-c21".to_owned(),
                quantity: 1,
                category_name: "(New) Maybeboard".to_owned(),
                inactive: true,
                finish: None,
                label_name: None,
                label_color: None,
            }],
        )
        .unwrap();

        let active: bool = conn
            .query_row(
                "SELECT is_active FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
                params![id, "(New) Maybeboard"],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !active,
            "a pile the import made for a {{noDeck}} line is switched off"
        );
    }

    /// A pile the reader already has is **left alone**, however the file describes it.
    ///
    /// An import must not reach into filing somebody did by hand: `category_for_name` finds before
    /// it creates, and the `existed` lookup `categories_created` already makes is the same fact.
    #[test]
    fn an_import_never_switches_off_a_pile_the_reader_already_had() {
        let conn = seeded();
        let id = deck(&conn);
        let keepers = crate::deck_meta::create_category(&conn, id, "live", "Keepers")
            .unwrap()
            .id;

        commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[ImportItem {
                card_id: "sol-c21".to_owned(),
                quantity: 1,
                category_name: "Keepers".to_owned(),
                inactive: true,
                finish: None,
                label_name: None,
                label_color: None,
            }],
        )
        .unwrap();

        let active: bool = conn
            .query_row(
                "SELECT is_active FROM deck_categories WHERE id = ?1",
                params![keepers],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            active,
            "an import may not switch off a pile the reader made"
        );
    }

    // ------------------------------------------------------------------------------------
    // Archidekt's labels — `ImportItem::label_name` / `label_color`
    // ------------------------------------------------------------------------------------

    /// One line wearing a label, otherwise [`item`]'s.
    fn labelled(card_id: &str, category_name: &str, label: &str, color: &str) -> ImportItem {
        ImportItem {
            label_name: Some(label.to_owned()),
            label_color: Some(color.to_owned()),
            ..item(card_id, 1, category_name)
        }
    }

    /// Every `deck_labels` row, as `(name, color)`, oldest first.
    fn labels_in(conn: &Connection) -> Vec<(String, String)> {
        conn.prepare("SELECT name, color FROM deck_labels ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    /// The label on one deck card, by the printing it names.
    fn label_on(conn: &Connection, deck_id: i64, card_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT t.name FROM deck_cards dc
               LEFT JOIN deck_labels t ON t.id = dc.label_id
              WHERE dc.deck_id = ?1 AND dc.card_id = ?2",
            params![deck_id, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn an_import_makes_the_label_the_file_named_and_wears_it() {
        let conn = seeded();
        let id = deck(&conn);

        let outcome = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[labelled("sol-c21", "Ramp", "Keeper", "#4aab08")],
        )
        .unwrap();

        assert_eq!(
            labels_in(&conn),
            vec![("Keeper".to_owned(), "#4aab08".to_owned())]
        );
        assert_eq!(label_on(&conn, id, "sol-c21").as_deref(), Some("Keeper"));
        assert_eq!(outcome.labels_created, 1);
    }

    /// The reader's instruction, in one test: **find first, and take nothing from the file when
    /// you find something.**
    ///
    /// A label they already have keeps its own capitals and its own colour. It matters more here
    /// than the same rule does for a category, because `deck_labels` has no `deck_id` since schema
    /// v21 — recolouring one recolours it in every deck they own.
    #[test]
    fn an_import_uses_an_existing_label_and_ignores_the_file_s_colour() {
        let conn = seeded();
        let id = deck(&conn);
        let mine = crate::deck_meta::create_label(&conn, Some(id), "Keeper", "#d9b95c")
            .unwrap()
            .id;

        let outcome = commit_import(
            &conn,
            id,
            "live",
            "merge",
            // A different case *and* a different colour, so neither could be a coincidence.
            &[labelled("sol-c21", "Ramp", "KEEPER", "#4aab08")],
        )
        .unwrap();

        assert_eq!(
            labels_in(&conn),
            vec![("Keeper".to_owned(), "#d9b95c".to_owned())],
            "the row is used as it stands — not renamed to the file's capitals, not recoloured"
        );
        assert_eq!(
            outcome.labels_created, 0,
            "nothing was made, so nothing is reported"
        );
        let worn: i64 = conn
            .query_row(
                "SELECT label_id FROM deck_cards WHERE deck_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(worn, mine);
    }

    /// `label_name_key`'s comparison, over one list: `Keeper` and `keeper` are one label, so the
    /// second line finds the row the first made rather than colliding with the UNIQUE index.
    #[test]
    fn two_spellings_of_one_label_in_one_list_are_one_row() {
        let conn = seeded();
        let id = deck(&conn);

        let outcome = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[
                labelled("sol-c21", "Ramp", "Keeper", "#4aab08"),
                labelled("sol-40k", "Ramp", "keeper", "#ff0000"),
            ],
        )
        .unwrap();

        assert_eq!(
            labels_in(&conn),
            vec![("Keeper".to_owned(), "#4aab08".to_owned())]
        );
        assert_eq!(outcome.labels_created, 1, "one label, counted once");
    }

    /// **A merge coalesces where quantity sums**, and that asymmetry is what a `merge` promises:
    /// two copies of a card are three copies, but a label the reader put on a row by hand is a
    /// decision this import may not overturn.
    #[test]
    fn a_merge_keeps_a_label_the_reader_put_on_by_hand() {
        let conn = seeded();
        let id = deck(&conn);
        commit_import(&conn, id, "live", "merge", &[item("sol-c21", 1, "Ramp")]).unwrap();
        let ramp: i64 = conn
            .query_row(
                "SELECT category_id FROM deck_cards WHERE deck_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        let mine = crate::deck_meta::create_label(&conn, Some(id), "Cut candidate", "#d3202a")
            .unwrap()
            .id;
        crate::deck_meta::set_card_label(&conn, id, "sol-c21", ramp, "live", None, Some(mine))
            .unwrap();

        commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[labelled("sol-c21", "Ramp", "Keeper", "#4aab08")],
        )
        .unwrap();

        let (quantity, label): (i64, Option<String>) = conn
            .query_row(
                "SELECT dc.quantity, t.name FROM deck_cards dc
                   LEFT JOIN deck_labels t ON t.id = dc.label_id
                  WHERE dc.deck_id = ?1 AND dc.category_id = ?2",
                params![id, ramp],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(quantity, 2, "the copies still sum");
        assert_eq!(
            label.as_deref(),
            Some("Cut candidate"),
            "the reader's label survives; the file's fills in an unlabelled row and nothing else"
        );
        assert!(
            labels_in(&conn).iter().any(|(n, _)| n == "Keeper"),
            "the file's label is still made — it is only this row it may not claim"
        );
    }

    /// A name with no colour beside it is a caller bug, not a shape to paper over:
    /// `deck_labels.color` is NOT NULL and what a colour *is* belongs to the webview.
    #[test]
    fn a_label_with_no_colour_is_refused_rather_than_defaulted() {
        let conn = seeded();
        let id = deck(&conn);

        let refusal = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[ImportItem {
                label_name: Some("Keeper".to_owned()),
                label_color: None,
                ..item("sol-c21", 1, "Ramp")
            }],
        )
        .unwrap_err();

        assert!(refusal.contains("colour"), "{refusal}");
        assert!(
            labels_in(&conn).is_empty(),
            "the transaction rolled back, so no half-made label survives"
        );
    }

    #[test]
    fn a_section_name_lands_on_the_predefined_category() {
        let conn = seeded();
        let id = deck(&conn);
        let before: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();

        let out = commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[item("sol-clb", 1, "Sideboard")],
        )
        .unwrap();

        assert_eq!(out.categories_created, 0);
        let (kind, after): (String, i64) = conn
            .query_row(
                "SELECT cat.kind, (SELECT count(*) FROM deck_categories WHERE deck_id = ?1)
                   FROM deck_cards dc JOIN deck_categories cat ON cat.id = dc.category_id
                  WHERE dc.deck_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            kind, "side",
            "the seeded row, whose kind is what the rules read"
        );
        assert_eq!(after, before, "and nothing new was made");
    }

    #[test]
    fn a_merge_records_one_audit_row_and_a_replace_records_two() {
        let conn = seeded();
        let id = deck(&conn);

        clear_history(&conn);
        commit_import(&conn, id, "live", "merge", &[item("sol-clb", 2, "Ramp")]).unwrap();
        let merged = audit(&conn, id);
        assert_eq!(merged.len(), 1, "{merged:?}");
        assert_eq!(merged[0].0, crate::deck_audit::ADD);
        assert_eq!(merged[0].1, 2, "the copies the list put in");
        assert_eq!(
            merged[0].2,
            serde_json::json!({
                // `labelsCreated` is 0 for a list carrying no labels, which is every format but
                // Archidekt's — and the key is written rather than omitted, so `auditText.ts`
                // reading an absent one as 0 is a rule about *old* rows and not about this path.
                "import": {
                    "mode": "merge", "lines": 1, "cards": 2, "categories": 1, "labelsCreated": 0
                }
            })
        );

        clear_history(&conn);
        commit_import(
            &conn,
            id,
            "live",
            "replace",
            &[item("jotun", 1, "Ramp"), item("kolvori", 1, "Creature")],
        )
        .unwrap();
        let replaced = audit(&conn, id);
        assert_eq!(replaced.len(), 2, "{replaced:?}");
        assert_eq!(
            replaced[0].0,
            crate::deck_audit::REMOVE,
            "what went out first"
        );
        assert_eq!(replaced[0].1, -2);
        assert_eq!(
            replaced[0].2,
            serde_json::json!({ "import": { "mode": "replace", "cleared": 2 } })
        );
        assert_eq!(replaced[1].0, crate::deck_audit::ADD);
        assert_eq!(replaced[1].1, 2);
        assert_eq!(
            replaced[1].2,
            serde_json::json!({
                "import": {
                    "mode": "replace", "lines": 2, "cards": 2, "categories": 2, "labelsCreated": 0
                }
            })
        );
    }

    /// A replace that finds nothing to clear records **one** row, not one with a zero in it —
    /// a history of a removal that removed nothing is a line the drawer would have to explain.
    #[test]
    fn a_replace_over_an_empty_variant_records_only_the_add() {
        let conn = seeded();
        let id = deck(&conn);
        clear_history(&conn);

        let out =
            commit_import(&conn, id, "live", "replace", &[item("sol-clb", 1, "Ramp")]).unwrap();

        assert_eq!(out.removed, 0);
        let rows = audit(&conn, id);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].0, crate::deck_audit::ADD);
    }

    /// **The copies behind a replaced `live` list come back** — issue #336, which was this
    /// command running `clear_variant`'s exact DELETE with no release beside it.
    ///
    /// What would be wrong the other way is not a wrong number, it is cards the reader owns
    /// going missing: a `deck_cards` row is an intention and a row in the deck's group is
    /// cardboard, so a list emptied without releasing leaves every copy filed under a deck that
    /// has no row for it — invisible on the Collection page since schema v25, and unavailable to
    /// every other deck for ever.
    ///
    /// **Two piles holding one printing**, because that is the shape where the release has to
    /// walk more than one `deck_cards` row for a single group row, and where `removed` being
    /// copies rather than rows is visible: 2 + 1 is three cards over two rows.
    #[test]
    fn a_replace_files_the_live_copies_it_clears_into_recently_removed() {
        let conn = seeded();
        let id = deck(&conn);
        put(&conn, id, "sol-clb", "Ramp", "live", 2);
        put(&conn, id, "sol-clb", "Main deck", "live", 1);
        file_into_group(&conn, id, "sol-clb", 3);
        let group = group_of(&conn, id);
        let removed = removed_group(&conn);
        assert_eq!(
            folder_copies(&conn, group, "sol-clb"),
            3,
            "before the import"
        );

        // A different printing, so the imported list has nothing to do with the copies that
        // were there — the reader replaced their list, not their cards.
        let out =
            commit_import(&conn, id, "live", "replace", &[item("sol-40k", 1, "Ramp")]).unwrap();

        assert_eq!(
            folder_copies(&conn, group, "sol-clb"),
            0,
            "the deck no longer lists them, so its group may not go on holding them"
        );
        assert_eq!(
            folder_copies(&conn, removed, "sol-clb"),
            3,
            "every copy is in `Recently removed`, where the reader can find and re-file it"
        );
        assert_eq!(
            out.removed, 3,
            "copies, not rows — two `deck_cards` rows held three cards"
        );
    }

    /// **A plan holds no cards** ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so a
    /// replace of the theory list releases nothing — and, more to the point, must not reach the
    /// custody of the `live` list standing beside it. Wrong the other way, clearing a
    /// scratchpad would empty the deck the reader had actually built.
    #[test]
    fn a_replace_of_a_plan_moves_no_copies() {
        let conn = seeded();
        let id = deck(&conn);
        put(&conn, id, "sol-clb", "Ramp", "live", 2);
        put(&conn, id, "sol-clb", "Ramp", "theory", 2);
        file_into_group(&conn, id, "sol-clb", 2);
        let group = group_of(&conn, id);
        let removed = removed_group(&conn);

        commit_import(
            &conn,
            id,
            "theory",
            "replace",
            &[item("sol-40k", 1, "Ramp")],
        )
        .unwrap();

        assert_eq!(
            folder_copies(&conn, group, "sol-clb"),
            2,
            "the live list still lists them and its group still holds them"
        );
        assert_eq!(
            folder_copies(&conn, removed, "sol-clb"),
            0,
            "and nothing was filed into the holding area"
        );
    }

    /// A merge takes nothing out of the list, so it gives nothing back: the release is tied to
    /// the DELETE and not to the command. Wrong the other way, every ordinary import would
    /// scatter the deck's copies into `Recently removed` while adding to the very list they back.
    #[test]
    fn a_merge_moves_no_copies() {
        let conn = seeded();
        let id = deck(&conn);
        put(&conn, id, "sol-clb", "Ramp", "live", 2);
        file_into_group(&conn, id, "sol-clb", 2);
        let group = group_of(&conn, id);
        let removed = removed_group(&conn);

        commit_import(&conn, id, "live", "merge", &[item("sol-40k", 1, "Ramp")]).unwrap();

        assert_eq!(folder_copies(&conn, group, "sol-clb"), 2);
        assert_eq!(folder_copies(&conn, removed, "sol-clb"), 0);
    }

    /// The transaction rule, from the outside and at the worst moment: a **replace** whose
    /// second item names a card this app has not got. By then the clear has run, a category has
    /// been made and the first card has been written — and every one of those must be gone,
    /// including the deck the reader was about to lose.
    ///
    /// **And since issue #336 the release has run too, which is the half of this that is about
    /// cardboard rather than rows.** [`crate::deck::release_live_copies`] files the group's
    /// copies into `Recently removed` *before* the DELETE and inside this transaction, so a
    /// rollback has to put them back in the group — a refused import that moved a reader's cards
    /// anyway would be the worst failure this command has, because the deck would read exactly
    /// as it did while the collection page quietly disagreed. The two folder assertions are the
    /// only thing standing between that and a green suite: every other assertion here passes
    /// with the copies in the wrong folder.
    #[test]
    fn a_refused_import_leaves_no_history_and_no_cards() {
        let conn = seeded();
        let id = deck(&conn);
        put(&conn, id, "sol-clb", "Main deck", "live", 3);
        file_into_group(&conn, id, "sol-clb", 3);
        clear_history(&conn);

        let refused = commit_import(
            &conn,
            id,
            "live",
            "replace",
            &[
                item("jotun", 1, "Ramp"),
                item("no-such-printing", 1, "Ramp"),
            ],
        )
        .unwrap_err();

        assert!(refused.contains("no-such-printing"), "{refused}");
        assert_eq!(
            cards_in(&conn, id, "live"),
            vec![holding("sol-clb", "Main deck", 3)],
            "the deck the replace was about to clear is still there"
        );
        assert_eq!(audit(&conn, id), vec![], "and it left no history");
        let ramps: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1 AND name = 'Ramp'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ramps, 0, "nor the category it made on the way through");
        assert_eq!(
            folder_copies(&conn, group_of(&conn, id), "sol-clb"),
            3,
            "and the copies the release had already filed away are back in the deck's group"
        );
        assert_eq!(
            folder_copies(&conn, removed_group(&conn), "sol-clb"),
            0,
            "so `Recently removed` holds nothing from an import that never happened"
        );
    }

    #[test]
    fn an_unknown_variant_and_an_unknown_mode_are_both_refused_in_words() {
        let conn = seeded();
        let id = deck(&conn);
        let one = [item("sol-clb", 1, "Ramp")];

        let variant = commit_import(&conn, id, "sideboard", "merge", &one).unwrap_err();
        assert!(variant.contains("`sideboard`"), "{variant}");
        assert!(variant.contains("live, theory"), "{variant}");

        let mode = commit_import(&conn, id, "live", "append", &one).unwrap_err();
        assert!(mode.contains("`append`"), "{mode}");
        assert!(mode.contains("merge, replace"), "{mode}");

        assert_eq!(cards_in(&conn, id, "live"), vec![]);
    }

    #[test]
    fn an_empty_item_list_is_refused() {
        let conn = seeded();
        let id = deck(&conn);
        clear_history(&conn);

        assert_eq!(
            commit_import(&conn, id, "live", "replace", &[]).unwrap_err(),
            NOTHING_TO_IMPORT,
            "and a `replace` least of all — it would clear the deck and put nothing back"
        );
        assert_eq!(audit(&conn, id), vec![]);
    }

    /// The same refusal `deck::add_card` gives a quantity of zero, from the one constant that
    /// owns the sentence — a line asking for no copies would conjure a row out of nothing, and
    /// `deck_cards`' own `CHECK (quantity > 0)` would answer with the table's name instead.
    #[test]
    fn an_item_asking_for_no_copies_is_refused() {
        let conn = seeded();
        let id = deck(&conn);

        let refused =
            commit_import(&conn, id, "live", "merge", &[item("sol-clb", 0, "Ramp")]).unwrap_err();

        assert_eq!(refused, crate::collection::ZERO_ADD);
        assert_eq!(cards_in(&conn, id, "live"), vec![]);
    }

    /// A deck id the gallery has not noticed is gone answers [`crate::deck::GONE`], one
    /// statement before there is an orphan row to worry about — the fence every deck write
    /// opens with, and this one is no exception.
    #[test]
    fn an_import_into_a_deck_that_is_not_there_is_refused() {
        let conn = seeded();

        let refused =
            commit_import(&conn, 4321, "live", "merge", &[item("sol-clb", 1, "Ramp")]).unwrap_err();

        assert_eq!(refused, crate::deck::GONE);
    }

    /// `printing_count` is how many rows *this line's rule* found, which through the bare-name
    /// arm is the card's paper printings — and through the other arms is not. Both halves are
    /// asserted, because the field's doc is what Task 6 will build an affordance on.
    ///
    /// It is **language-blind**: the count is what the reader is choosing between, and a
    /// Japanese printing is one of them even though [`MATCH_ORDER`] will not pick it.
    #[test]
    fn printing_count_is_the_number_of_paper_printings_of_that_name() {
        let conn = seeded();
        let m = resolve_one(&conn, line("Sol Ring")).matched.unwrap();
        assert_eq!(
            m.printing_count, 5,
            "five paper printings, Japanese included — and Arena's is not one"
        );
        let hinted_row = resolve_one(&conn, hinted("Sol Ring", "c21", Some("263")))
            .matched
            .unwrap();
        assert_eq!(
            hinted_row.printing_count, 1,
            "through a printing hint it counts what the hint named, not the card's printings"
        );
    }

    // ------------------------------------------------------------------------------------
    // read_import_file
    // ------------------------------------------------------------------------------------

    /// A file in the system temp directory, written and handed back with its path.
    ///
    /// **There is no `tempfile` dev-dependency and this must not add one**, so the collision
    /// fence is the name: `maintenance.rs`'s scratch directories are `mtgtest-maint-<what>` and
    /// have a known race between tests that share a word, so every caller here passes a word no
    /// other test in the crate uses. `cargo test` runs a thread per test by default and the
    /// temp directory is shared by every crate on the machine — a fixed name like
    /// `mtgtest-import.txt` would be two tests writing one file.
    ///
    /// The caller cleans up with [`gone`]. A leaked file is a stale fixture the *next* run
    /// would read, which is the one failure mode worth spending two lines on.
    fn scratch(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("mtgtest-import-{name}.txt"));
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// Undo [`scratch`]. Ignores a failure — the file is the test's, not the app's.
    fn gone(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
    }

    /// [`read_import_file`] over a `Path`.
    fn read_file(path: &std::path::Path) -> Result<ImportFile, String> {
        read_import_file(path.to_str().unwrap())
    }

    /// The cap is a **fence**, and the half worth pinning is that it costs a megabyte rather
    /// than the whole file.
    ///
    /// The bound is `take(MAX + 1)` and a length test: a 200 MB file the reader pointed at by
    /// mistake never reaches memory, because the reader stops one byte past the cap. The
    /// refusal does not quote the file's real size, because a bounded read never learns it.
    ///
    /// What this test can see is the message and the fact that no text came back; the bound
    /// itself is structural. Note the fixture is one byte over [`MAX_IMPORT_BYTES`] — the cap is
    /// `>`, so a file of exactly the cap is allowed and this file is the smallest one that is
    /// not.
    #[test]
    fn a_file_over_the_cap_is_refused_by_size_and_not_read() {
        let oversized = vec![b'x'; usize::try_from(MAX_IMPORT_BYTES).unwrap() + 1];
        let path = scratch("oversized", &oversized);

        let refused = read_file(&path).unwrap_err();

        assert!(refused.contains("at most 1 MB"), "{refused}");
        assert!(
            refused.contains("That file is over"),
            "it says the cap was passed, which is all a bounded read can know: {refused}"
        );
        gone(&path);
    }

    /// A file that is exactly the cap is read, because the fence is `>` and a boundary nobody
    /// asserts is a boundary that moves.
    #[test]
    fn a_file_at_exactly_the_cap_is_read() {
        let full = vec![b'x'; usize::try_from(MAX_IMPORT_BYTES).unwrap()];
        let path = scratch("at-the-cap", &full);

        let file = read_file(&path).expect("exactly the cap is under it");

        assert_eq!(u64::try_from(file.text.len()).unwrap(), MAX_IMPORT_BYTES);
        assert_eq!(file.encoding, FileEncoding::Utf8);
        gone(&path);
    }

    /// A path that names nothing is a sentence, not a panic and not an empty import.
    ///
    /// It is reachable in the shipped app despite the picker: the reader can delete or unmount
    /// the file between choosing it and the read, and a portable copy moved between machines
    /// carries no such file at all.
    #[test]
    fn a_missing_file_is_refused_in_words() {
        let path = std::env::temp_dir().join("mtgtest-import-no-such-decklist.txt");
        let _ = std::fs::remove_file(&path);

        let refused = read_file(&path).unwrap_err();

        assert!(
            refused.starts_with("That file could not be opened"),
            "{refused}"
        );
        assert!(
            refused.len() > "That file could not be opened — ".len(),
            "the OS's own reason is kept, because `not found` and `access denied` are \
             different things for the reader to do something about: {refused}"
        );
    }

    /// **The file the lossy read used to damage.** A decklist exported by a Windows tool that
    /// never left code page 1252 carries `0x92` where a curly apostrophe belongs and `0xF6` where
    /// `ö` does, and neither is valid UTF-8. The lossy read turned both into `U+FFFD` and every
    /// such line into an unmatched name (issue #555); this reads them as the characters they are.
    ///
    /// 105 lines through the real file path, so the cap, the read and [`decode`] are one test:
    /// nothing is lost, the 103 plain lines are untouched, and the two that carried a cp1252 byte
    /// come back as the names a reader would have typed.
    #[test]
    fn a_file_that_is_not_utf8_is_read_as_windows_1252() {
        let mut bytes = Vec::new();
        for _ in 0..103 {
            bytes.extend_from_slice(b"1 Sol Ring\n");
        }
        bytes.extend_from_slice(b"1 Yawgmoth\x92s Will\n");
        bytes.extend_from_slice(b"1 J\xF6tun Grunt\n");
        let path = scratch("cp1252", &bytes);

        let file = read_file(&path).expect("a legacy code page is not a failed import");

        assert_eq!(file.encoding, FileEncoding::Windows1252);
        assert_eq!(file.text.lines().count(), 105, "no line was lost");
        assert_eq!(file.text.matches("1 Sol Ring").count(), 103);
        let tail: Vec<&str> = file.text.lines().skip(103).collect();
        assert_eq!(tail, ["1 Yawgmoth\u{2019}s Will", "1 Jötun Grunt"]);
        assert!(!file.text.contains('\u{FFFD}'), "nothing was replaced");
        gone(&path);
    }

    /// A UTF-16 file through the same path — what Windows' "Unicode" save writes — so the mark
    /// is read off the real bytes on disk and not only off a slice in a unit test.
    #[test]
    fn a_utf16_file_is_read_through_the_command_path() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "4 Æther Vial\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = scratch("utf16", &bytes);

        let file = read_file(&path).expect("a byte-order mark is an answer, not a failure");

        assert_eq!(file.encoding, FileEncoding::Utf16Le);
        assert_eq!(file.text, "4 Æther Vial\r\n");
        gone(&path);
    }

    /// Valid UTF-8 is UTF-8, left exactly as it was — an `é` written as two bytes stays one
    /// `é` rather than becoming the two Latin-1 characters a code page would read it as.
    #[test]
    fn valid_utf8_is_read_as_utf8_and_left_alone() {
        let file = decode("1 Jötun Grunt\n1 Séance\n".as_bytes());
        assert_eq!(file.encoding, FileEncoding::Utf8);
        assert_eq!(file.text, "1 Jötun Grunt\n1 Séance\n");
    }

    /// Notepad and Excel's "CSV UTF-8" both write a mark, and left in it glues `U+FEFF` to the
    /// first cell — a header whose `Quantity` no longer says `Quantity`.
    #[test]
    fn a_utf8_byte_order_mark_is_stripped() {
        let file = decode(b"\xEF\xBB\xBFQuantity,Name\n1,S\xC3\xA9ance\n");
        assert_eq!(file.encoding, FileEncoding::Utf8);
        assert_eq!(file.text, "Quantity,Name\n1,Séance\n");
    }

    /// Both byte orders, named by their marks, and the mark itself never reaches the text.
    #[test]
    fn a_utf16_byte_order_mark_names_the_byte_order() {
        let text = "1 Lim-Dûl's Vault\n";
        let mut le = vec![0xFF, 0xFE];
        let mut be = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(
            decode(&le),
            ImportFile {
                text: text.to_owned(),
                encoding: FileEncoding::Utf16Le
            }
        );
        assert_eq!(
            decode(&be),
            ImportFile {
                text: text.to_owned(),
                encoding: FileEncoding::Utf16Be
            }
        );
    }

    /// A damaged UTF-16 file is the one place a replacement character is honest — there is no
    /// byte to recover — and it still costs one character rather than the file.
    #[test]
    fn a_damaged_utf16_file_costs_one_character_and_not_the_file() {
        // `A`, an unpaired high surrogate, `B`, then half of a unit.
        let bytes = [0xFF, 0xFE, b'A', 0, 0x00, 0xD8, b'B', 0, b'C'];
        let file = decode(&bytes);
        assert_eq!(file.encoding, FileEncoding::Utf16Le);
        assert_eq!(file.text, "A\u{FFFD}B\u{FFFD}");
    }

    /// **The table, pinned where it can be wrong.** `0xE9` is `é` and `0x92` the curly apostrophe
    /// — the two bytes a Western European Excel CSV is made of — and the C1 block is not Latin-1:
    /// `0x80` is `€`, `0x96`/`0x97` are the dashes. The five bytes the code page leaves undefined
    /// map to the C1 control of the same number, WHATWG's rule, rather than to `U+FFFD`. Below
    /// `0x80` and from `0xA0` up it is Latin-1, and every byte is exactly one character.
    #[test]
    fn windows_1252_reads_every_byte_as_one_character() {
        let file = decode(b"S\xE9ance \x96 Yawgmoth\x92s Will \x80");
        assert_eq!(file.encoding, FileEncoding::Windows1252);
        assert_eq!(file.text, "Séance \u{2013} Yawgmoth\u{2019}s Will €");

        for (byte, ch) in [
            (0x80, '\u{20AC}'),
            (0x8A, 'Š'),
            (0x8C, 'Œ'),
            (0x91, '\u{2018}'),
            (0x92, '\u{2019}'),
            (0x93, '\u{201C}'),
            (0x97, '\u{2014}'),
            (0x99, '\u{2122}'),
            (0x9C, 'œ'),
            (0x9F, 'Ÿ'),
            (0xA0, '\u{00A0}'),
            (0xE6, 'æ'),
            (0xE9, 'é'),
            (0xF6, 'ö'),
            (0xFF, 'ÿ'),
        ] {
            assert_eq!(cp1252(byte), ch, "{byte:#04x}");
        }
        for undefined in [0x81u8, 0x8D, 0x8F, 0x90, 0x9D] {
            assert_eq!(cp1252(undefined), char::from(undefined), "{undefined:#04x}");
        }

        let every: Vec<u8> = (0..=255).collect();
        let file = decode(&every);
        assert_eq!(file.encoding, FileEncoding::Windows1252);
        assert_eq!(
            file.text.chars().count(),
            256,
            "one character per byte, none dropped"
        );
        assert!(!file.text.contains('\u{FFFD}'));
    }

    /// The four strings `src/lib/ipc.ts`'s `ImportFile.encoding` union names, exactly — a
    /// `rename` that drifted would reach the dialog as a value its `=== "windows-1252"` test never
    /// matches, and the notice would silently stop being drawn.
    #[test]
    fn the_encoding_crosses_ipc_as_the_mirror_spells_it() {
        let wire = |encoding| {
            serde_json::to_value(ImportFile {
                text: "x".to_owned(),
                encoding,
            })
            .unwrap()
        };
        assert_eq!(
            wire(FileEncoding::Utf8),
            json!({ "text": "x", "encoding": "utf-8" })
        );
        assert_eq!(wire(FileEncoding::Utf16Le)["encoding"], "utf-16le");
        assert_eq!(wire(FileEncoding::Utf16Be)["encoding"], "utf-16be");
        assert_eq!(wire(FileEncoding::Windows1252)["encoding"], "windows-1252");
    }
}
