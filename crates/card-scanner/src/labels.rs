//! The labels, as bytes — for a host that has a session and no database to read them from.
//!
//! [`Reference::load_labels`] reads eleven columns of every row of `corpus.db`'s `cards` and
//! attaches each as a [`Label`]. A browser's scanner runs in a Worker of its own, on a module
//! of this crate alone (`crates/grimoire-scan`, the light app's step 7.5): the corpus is the
//! engine's, in another Worker, behind the one connection its storage permits. So the engine
//! reads the same eleven columns, writes them down here ([`Encoder`], [`read_page`]), and hands
//! the bytes across; the scanner's module reads them back ([`decode`]) and attaches them
//! ([`attach`]) through the same two calls `load_labels` makes, in the same order.
//!
//! **Decoding needs no feature.** The `corpus` feature is SQLite, and a module with SQLite in
//! it is the one this exists to avoid. [`Row`], [`Encoder`], [`decode`] and [`attach`] are
//! plain code; only [`read_page`], which reads a connection, is behind `corpus`.
//!
//! ## The layout — version 4
//!
//! ```text
//! "MTGL"                      4 bytes
//! version                     1 byte, [`VERSION`]
//! rows                        varint
//! six string tables, in this order: name, set, collector number, language, release date, finish
//!     entries                 varint
//!     entries ×  length       varint, then that many bytes of UTF-8
//! one id table: oracle
//!     entries                 varint
//!     entries ×  id           16 bytes
//! rows ×
//!     id                      16 bytes
//!     oracle                  varint: 0 for none, else 1 + its place in the oracle table
//!     name, set, number,      five varints, each a place in its own table
//!       language, released
//!     finishes                varint n, then n varints, each a place in the finish table
//!     flags                   1 byte: [`PROMO`] for a printing the corpus marks a promo,
//!                               [`TOKEN`] for a token or an emblem ([`is_token`]); no other bit
//! ```
//!
//! Version 1 had no promo byte; version 2's last byte was the promo alone, 0 or 1, version 3
//! made it the flags, for the tokens a session leaves out (issue #1323), and version 4 dropped
//! the illustration ids, which only the hash bundle's art search read. Both ends of a hand-over
//! are one build, so an older file is never met and is refused like any other.
//!
//! A varint is LEB128, least significant group first, ten bytes at most. Nothing follows the
//! last row.
//!
//! **Tables, because a label is mostly words it shares.** Counted on the dev corpus
//! (2026-10-07, 118 475 printings): 38 260 names, 1 052 sets, 16 833 collector numbers, 19
//! languages, 1 288 release dates and 38 705 oracle ids. Written a row at a time with every
//! word spelled out the file would be some 10.6 MB; with each word written once and a row naming
//! it by its place it was 5 998 193 B in version 3, which also carried 51 236 illustration ids.
//! A table is in first-seen order, so the encoder is one pass over the rows and holds none of
//! them.
//!
//! **A release date that was `NULL` is the empty string**, as `load_labels` reads it, and a
//! printing with no finishes has none here. Rows are in the order they were pushed, which for
//! [`read_page`] is `rowid` order — the order a scan of `cards` walks, so what is attached
//! first here is what `load_labels` attaches first — and a printing met twice keeps its later
//! label either way.
//!
//! **The decoder trusts nothing.** The bytes cross from another Worker, and a module that
//! panics is a module that has ended (`host::guard` guards nothing where a panic aborts). Every
//! count is held against the bytes that are left before anything is allocated for it, every
//! place against its table, every string against UTF-8, and [`attach`] reads the whole file
//! before it attaches the first row — a refusal leaves the reference exactly as it was.

use crate::ids::ID_LEN;
use crate::reference::{Label, Reference};
use std::collections::HashMap;

/// The first four bytes of a labels file.
pub const MAGIC: [u8; 4] = *b"MTGL";
/// The layout above. A number is never reused, as the bundle's is not.
pub const VERSION: u8 = 4;

/// A row's flags: the corpus marks the printing a promo.
pub const PROMO: u8 = 1;
/// A row's flags: the printing is a token or an emblem.
pub const TOKEN: u8 = 2;

/// The string tables, in the order the file holds them.
const NAME: usize = 0;
const SET: usize = 1;
const NUMBER: usize = 2;
const LANG: usize = 3;
const RELEASED: usize = 4;
const FINISH: usize = 5;
const STRING_TABLES: [&str; 6] =
    ["name", "set", "collector number", "language", "release date", "finish"];
/// The fewest bytes a row can be: its id, an absent oracle, five places, no finishes and its
/// flags.
const MIN_ROW: usize = ID_LEN + 1 + 5 + 1 + 1;

/// One printing, as `corpus.db` has it: what [`Reference::load_labels`] reads from one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: [u8; ID_LEN],
    pub oracle: Option<[u8; ID_LEN]>,
    pub label: Label,
    /// The finishes the printing exists in, in the order the corpus lists them.
    pub finishes: Vec<String>,
    /// The corpus marks it a promo (Scryfall's `promo`). See
    /// [`crate::filters::ScanFilters::exclude_promos`].
    pub promo: bool,
    /// A token or an emblem ([`is_token`]) — what a session leaves out unless it admits tokens
    /// ([`crate::session::Session::set_tokens`]).
    pub token: bool,
}

impl Row {
    /// Attach this printing to `reference` — **the four calls `load_labels` makes, in its
    /// order**, so a reference built from a labels file is built by the code a reference built
    /// from the corpus is.
    pub fn attach(self, reference: &mut Reference) {
        reference.set_finishes(self.id, self.finishes);
        reference.set_promo(self.id, self.promo);
        reference.set_token(self.id, self.token);
        reference.add_label(self.id, self.oracle, self.label);
    }
}

/// The layouts that make a printing a token or an emblem by themselves.
const TOKEN_LAYOUTS: [&str; 3] = ["token", "double_faced_token", "emblem"];
/// The layouts a token can wear without being one — a real card wears them too — so the type line
/// says which.
const TWO_SIDED_LAYOUTS: [&str; 2] = ["flip", "reversible_card"];
/// What a token's or an emblem's type line, or one ` // ` face of it, begins with.
const TOKEN_LINE_WORDS: [&str; 2] = ["Token", "Emblem"];

/// **Is a printing a token or an emblem**, from its corpus `layout` and `type_line`?
///
/// The engine's rule (`grimoire_core::deck_tokens::is_token_printing`), spelled again here because
/// this crate sits below the engine; a test there holds the two to the same answers. A `token`,
/// `double_faced_token` or `emblem` layout is one by itself — the helper cards filed under those
/// layouts (The Monarch, Day // Night) included, which no reader sorting a collection wants
/// answered either; a `flip` or `reversible_card` printing is one when a face of its type line
/// begins `Token` or `Emblem` (the Role tokens, Mechtitan), and the real cards those two layouts
/// hold are not.
pub fn is_token(layout: &str, type_line: Option<&str>) -> bool {
    if TOKEN_LAYOUTS.contains(&layout) {
        return true;
    }
    TWO_SIDED_LAYOUTS.contains(&layout)
        && type_line.is_some_and(|line| {
            line.split(" // ")
                .any(|face| TOKEN_LINE_WORDS.iter().any(|word| face.starts_with(word)))
        })
}

/// The eleven columns a label is read from, in the order [`Row::from_sql`] reads them.
#[cfg(feature = "corpus")]
pub const COLUMNS: &str = "id, name, set_code, collector_number, lang, released_at, \
                           oracle_id, finishes, promo, layout, type_line";

#[cfg(feature = "corpus")]
impl Row {
    /// One row of `SELECT … COLUMNS …`, whose first column is at `at`. `None` for a row whose
    /// id is not a UUID, which `load_labels` has always skipped; an error for a column of the
    /// wrong type, which it has always skipped too.
    pub(crate) fn from_sql(r: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<Option<Row>> {
        let id: String = r.get(at)?;
        let label = Label {
            name: r.get(at + 1)?,
            set: r.get(at + 2)?,
            number: r.get(at + 3)?,
            lang: r.get(at + 4)?,
            released: r.get::<_, Option<String>>(at + 5)?.unwrap_or_default(),
        };
        let oracle: Option<String> = r.get(at + 6)?;
        let finishes: Option<String> = r.get(at + 7)?;
        let promo: Option<i64> = r.get(at + 8)?;
        let layout: Option<String> = r.get(at + 9)?;
        let type_line: Option<String> = r.get(at + 10)?;
        let Some(id) = crate::ids::parse_uuid(&id) else { return Ok(None) };
        Ok(Some(Row {
            id,
            oracle: oracle.as_deref().and_then(crate::ids::parse_uuid),
            label,
            finishes: crate::reference::parse_finishes(finishes.as_deref().unwrap_or("")),
            promo: promo.is_some_and(|p| p != 0),
            token: layout.is_some_and(|l| is_token(&l, type_line.as_deref())),
        }))
    }
}

/// What one [`read_page`] read.
#[cfg(feature = "corpus")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    /// The `rowid` of the last row it met — where the next page starts. `None` when it met none.
    pub last: Option<i64>,
    /// Rows met, the ones it skipped among them. Fewer than were asked for is the end of the
    /// table.
    pub met: usize,
}

/// Read at most `limit` rows of `cards` after the `rowid` `after` — 0 to begin — into `into`,
/// in `rowid` order.
///
/// **A page at a time, because one host cannot afford the whole read at once.** A scan of
/// `cards` for these columns walks every leaf of a table whose rows are kilobytes each — 3.0 s
/// for the dev corpus through `node:sqlite`, 2026-10-07 — and the web host's engine has one
/// thread, which every command the page sends is waiting for. So that host reads a page, lets
/// go of its connection, gives its event loop a turn when it owes one, and asks for the next
/// (`grimoire_web::host::scanner_labels`). The statement is prepared once per connection
/// (`prepare_cached`).
///
/// A row `load_labels` would skip is skipped here: an id that is not a UUID, a column of the
/// wrong type. Its `rowid` still counts, or a page of nothing but such rows would never end.
#[cfg(feature = "corpus")]
pub fn read_page(
    corpus: &rusqlite::Connection,
    after: i64,
    limit: usize,
    into: &mut Encoder,
) -> rusqlite::Result<Page> {
    let mut stmt = corpus.prepare_cached(&format!(
        "SELECT rowid, {COLUMNS} FROM cards WHERE rowid > ?1 ORDER BY rowid LIMIT ?2"
    ))?;
    let mut rows = stmt.query(rusqlite::params![after, limit as i64])?;
    let mut page = Page { last: None, met: 0 };
    while let Some(r) = rows.next()? {
        page.last = Some(r.get(0)?);
        page.met += 1;
        if let Ok(Some(row)) = Row::from_sql(r, 1) {
            into.push(&row);
        }
    }
    Ok(page)
}

// ---- Writing ------------------------------------------------------------------------------------

/// Writes a labels file, a row at a time. See the module for the layout.
#[derive(Default)]
pub struct Encoder {
    count: u64,
    strings: [Strings; 6],
    oracles: Ids,
    rows: Vec<u8>,
}

/// One string table being written: each word once, in the order it was first met.
#[derive(Default)]
struct Strings {
    seen: HashMap<String, u64>,
    bytes: Vec<u8>,
}

impl Strings {
    fn place(&mut self, word: &str) -> u64 {
        if let Some(at) = self.seen.get(word) {
            return *at;
        }
        let at = self.seen.len() as u64;
        self.seen.insert(word.to_owned(), at);
        put_varint(&mut self.bytes, word.len() as u64);
        self.bytes.extend_from_slice(word.as_bytes());
        at
    }
}

/// One id table being written.
#[derive(Default)]
struct Ids {
    seen: HashMap<[u8; ID_LEN], u64>,
    bytes: Vec<u8>,
}

impl Ids {
    /// 0 for no id, else 1 + its place.
    fn place(&mut self, id: Option<&[u8; ID_LEN]>) -> u64 {
        let Some(id) = id else { return 0 };
        if let Some(at) = self.seen.get(id) {
            return *at + 1;
        }
        let at = self.seen.len() as u64;
        self.seen.insert(*id, at);
        self.bytes.extend_from_slice(id);
        at + 1
    }
}

impl Encoder {
    pub fn new() -> Encoder {
        Encoder::default()
    }

    /// Rows pushed so far.
    pub fn len(&self) -> u64 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn push(&mut self, row: &Row) {
        self.count += 1;
        self.rows.extend_from_slice(&row.id);
        let oracle = self.oracles.place(row.oracle.as_ref());
        put_varint(&mut self.rows, oracle);
        let l = &row.label;
        for (table, word) in
            [(NAME, &l.name), (SET, &l.set), (NUMBER, &l.number), (LANG, &l.lang), (RELEASED, &l.released)]
        {
            let at = self.strings[table].place(word);
            put_varint(&mut self.rows, at);
        }
        put_varint(&mut self.rows, row.finishes.len() as u64);
        for finish in &row.finishes {
            let at = self.strings[FINISH].place(finish);
            put_varint(&mut self.rows, at);
        }
        let flag = |on: bool, bit: u8| if on { bit } else { 0 };
        self.rows.push(flag(row.promo, PROMO) | flag(row.token, TOKEN));
    }

    /// The file. Built in one allocation of its exact size.
    pub fn finish(self) -> Vec<u8> {
        let mut head = Vec::with_capacity(16);
        head.extend_from_slice(&MAGIC);
        head.push(VERSION);
        put_varint(&mut head, self.count);
        let counts: Vec<Vec<u8>> = self
            .strings
            .iter()
            .map(|t| t.seen.len())
            .chain(std::iter::once(self.oracles.seen.len()))
            .map(|n| {
                let mut v = Vec::with_capacity(4);
                put_varint(&mut v, n as u64);
                v
            })
            .collect();
        let tables =
            self.strings.iter().map(|t| &t.bytes).chain(std::iter::once(&self.oracles.bytes));
        let size = head.len()
            + counts.iter().map(Vec::len).sum::<usize>()
            + tables.clone().map(Vec::len).sum::<usize>()
            + self.rows.len();
        let mut out = Vec::with_capacity(size);
        out.extend_from_slice(&head);
        for (count, table) in counts.iter().zip(tables) {
            out.extend_from_slice(count);
            out.extend_from_slice(table);
        }
        out.extend_from_slice(&self.rows);
        out
    }
}

fn put_varint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push(n as u8 | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

// ---- Reading ------------------------------------------------------------------------------------

/// Why a run of bytes is not a labels file this build can read. `at` is a byte offset.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LabelsError {
    #[error("not a card-scanner labels file (bad magic)")]
    BadMagic,
    #[error("labels format version {found}, but this build understands {expected}")]
    BadVersion { found: u8, expected: u8 },
    #[error("the labels are truncated: {what} at byte {at} runs past the end of {len} bytes")]
    Truncated { what: &'static str, at: usize, len: usize },
    #[error("the labels are damaged: {what} at byte {at}")]
    Damaged { what: &'static str, at: usize },
}

/// Where a reader is in the file.
#[derive(Clone, Copy)]
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn left(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn truncated(&self, what: &'static str) -> LabelsError {
        LabelsError::Truncated { what, at: self.at, len: self.bytes.len() }
    }

    fn damaged(&self, what: &'static str) -> LabelsError {
        LabelsError::Damaged { what, at: self.at }
    }

    fn take(&mut self, n: usize, what: &'static str) -> Result<&'a [u8], LabelsError> {
        if n > self.left() {
            return Err(self.truncated(what));
        }
        let taken = &self.bytes[self.at..self.at + n];
        self.at += n;
        Ok(taken)
    }

    fn id(&mut self, what: &'static str) -> Result<[u8; ID_LEN], LabelsError> {
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(self.take(ID_LEN, what)?);
        Ok(id)
    }

    fn varint(&mut self, what: &'static str) -> Result<u64, LabelsError> {
        let mut n = 0u64;
        for group in 0..10 {
            let Some(byte) = self.bytes.get(self.at).copied() else {
                return Err(self.truncated(what));
            };
            // The tenth group has one bit of a `u64` left to give.
            if group == 9 && byte > 1 {
                return Err(self.damaged("a number too large to be one"));
            }
            self.at += 1;
            n |= u64::from(byte & 0x7f) << (7 * group);
            if byte & 0x80 == 0 {
                return Ok(n);
            }
        }
        Err(self.damaged("a number that never ends"))
    }

    /// A count of things that are each at least `each` bytes — **held against the bytes that
    /// are left before anybody allocates for it**, so a count of four billion in a file of
    /// forty bytes is a refusal and not an allocation.
    fn count(&mut self, each: usize, what: &'static str) -> Result<usize, LabelsError> {
        let before = *self;
        let n = self.varint(what)?;
        match usize::try_from(n) {
            Ok(n) if n <= self.left() / each => Ok(n),
            _ => Err(before.truncated(what)),
        }
    }

    /// A place in a table of `len` entries.
    fn place(&mut self, len: usize, what: &'static str) -> Result<usize, LabelsError> {
        let before = *self;
        let n = self.varint(what)?;
        match usize::try_from(n) {
            Ok(n) if n < len => Ok(n),
            _ => Err(before.damaged(what)),
        }
    }
}

/// A labels file that has been read through and found whole. Borrows the bytes.
pub struct Labels<'a> {
    rows: usize,
    strings: [Vec<&'a str>; 6],
    oracles: &'a [u8],
    /// At the first row.
    body: Cursor<'a>,
}

/// One row, still as places in the tables.
struct Parts<'a> {
    id: [u8; ID_LEN],
    oracle: Option<[u8; ID_LEN]>,
    words: [&'a str; 5],
    finishes: usize,
    /// At the first finish.
    finishes_at: Cursor<'a>,
    promo: bool,
    token: bool,
}

impl<'a> Labels<'a> {
    /// How many rows the file holds.
    pub fn len(&self) -> usize {
        self.rows
    }

    pub fn is_empty(&self) -> bool {
        self.rows == 0
    }

    /// Every row, in the file's order.
    pub fn rows(&self) -> impl Iterator<Item = Row> + '_ {
        let mut at = self.body;
        // `decode` has read every row once already, so `parts` cannot refuse here; were it to,
        // the rows end rather than the process.
        (0..self.rows).map_while(move |_| self.parts(&mut at).ok()).map(|p| self.row(&p))
    }

    fn oracle_at(&self, place: usize) -> [u8; ID_LEN] {
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(&self.oracles[place * ID_LEN..(place + 1) * ID_LEN]);
        id
    }

    fn oracle(&self, at: &mut Cursor<'a>) -> Result<Option<[u8; ID_LEN]>, LabelsError> {
        let entries = self.oracles.len() / ID_LEN;
        // One past the table, because 0 is "none" and an id's place is written as 1 + itself.
        let place = at.place(entries + 1, "a row's place in an id table")?;
        Ok(place.checked_sub(1).map(|p| self.oracle_at(p)))
    }

    fn word(&self, table: usize, at: &mut Cursor<'a>) -> Result<&'a str, LabelsError> {
        let place = at.place(self.strings[table].len(), "a row's place in a string table")?;
        Ok(self.strings[table][place])
    }

    fn parts(&self, at: &mut Cursor<'a>) -> Result<Parts<'a>, LabelsError> {
        let id = at.id("a row's id")?;
        let oracle = self.oracle(at)?;
        let mut words = [""; 5];
        for (table, word) in words.iter_mut().enumerate() {
            *word = self.word(table, at)?;
        }
        let finishes = at.count(1, "a row's finishes")?;
        let finishes_at = *at;
        for _ in 0..finishes {
            self.word(FINISH, at)?;
        }
        let before = *at;
        let flags = at.take(1, "a row's flags")?[0];
        if flags & !(PROMO | TOKEN) != 0 {
            return Err(before.damaged("a flag this build does not know"));
        }
        let (promo, token) = (flags & PROMO != 0, flags & TOKEN != 0);
        Ok(Parts { id, oracle, words, finishes, finishes_at, promo, token })
    }

    fn row(&self, p: &Parts<'a>) -> Row {
        let mut at = p.finishes_at;
        let finishes = (0..p.finishes)
            .map_while(|_| self.word(FINISH, &mut at).ok())
            .map(str::to_owned)
            .collect();
        Row {
            id: p.id,
            oracle: p.oracle,
            label: Label {
                name: p.words[NAME].to_owned(),
                set: p.words[SET].to_owned(),
                number: p.words[NUMBER].to_owned(),
                lang: p.words[LANG].to_owned(),
                released: p.words[RELEASED].to_owned(),
            },
            finishes,
            promo: p.promo,
            token: p.token,
        }
    }
}

/// Read a labels file through, and answer it only if all of it is sound: the magic, the
/// version, every table, every row's places, and nothing left over.
pub fn decode(bytes: &[u8]) -> Result<Labels<'_>, LabelsError> {
    if bytes.len() < MAGIC.len() || bytes[..MAGIC.len()] != MAGIC {
        return Err(LabelsError::BadMagic);
    }
    let mut at = Cursor { bytes, at: MAGIC.len() };
    let version = at.take(1, "the format version")?[0];
    if version != VERSION {
        return Err(LabelsError::BadVersion { found: version, expected: VERSION });
    }
    let rows = at.count(MIN_ROW, "the row count")?;

    let mut strings: [Vec<&str>; 6] = Default::default();
    for (table, name) in strings.iter_mut().zip(STRING_TABLES) {
        // Each entry is a length at least, so this many entries is this many bytes at least.
        let entries = at.count(1, name)?;
        // `entries` is bounded by the bytes that are left, and an entry here is a `&str` —
        // eight bytes where a pointer is four, sixteen where it is eight — so the reservation
        // can be several times the file. One the allocator will not make is a damaged file's
        // answer, never a capacity-overflow panic: in a browser's module a panic is a trap.
        let before = at;
        table.try_reserve_exact(entries).map_err(|_| before.damaged("a table too large to hold"))?;
        for _ in 0..entries {
            let len = at.count(1, name)?;
            let before = at;
            let word = std::str::from_utf8(at.take(len, name)?)
                .map_err(|_| before.damaged("a word that is not UTF-8"))?;
            table.push(word);
        }
    }
    let entries = at.count(ID_LEN, "oracle")?;
    let oracles = at.take(entries * ID_LEN, "oracle")?;

    let labels = Labels { rows, strings, oracles, body: at };
    for _ in 0..rows {
        labels.parts(&mut at)?;
    }
    if at.left() > 0 {
        return Err(at.damaged("bytes after the last row"));
    }
    Ok(labels)
}

/// Attach every row of a labels file to `reference`, and answer how many there were.
///
/// **All of them or none**: the file is read through first ([`decode`]), so a refusal leaves
/// `reference` as it was — a truncated hand-over is a session with no names, never one with
/// the first third of them.
pub fn attach(reference: &mut Reference, bytes: &[u8]) -> Result<usize, LabelsError> {
    let labels = decode(bytes)?;
    for row in labels.rows() {
        row.attach(reference);
    }
    Ok(labels.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> [u8; ID_LEN] {
        let mut raw = [0u8; ID_LEN];
        raw[0] = n;
        raw[ID_LEN - 1] = 0xa0 | (n & 0x0f);
        raw
    }

    fn row(
        n: u8,
        oracle: Option<u8>,
        name: &str,
        set: &str,
        number: &str,
        lang: &str,
        released: &str,
        finishes: &[&str],
    ) -> Row {
        Row {
            id: id(n),
            oracle: oracle.map(id),
            label: Label {
                name: name.into(),
                set: set.into(),
                number: number.into(),
                lang: lang.into(),
                released: released.into(),
            },
            finishes: finishes.iter().map(|f| f.to_string()).collect(),
            promo: false,
            token: false,
        }
    }

    fn promo(row: Row) -> Row {
        Row { promo: true, ..row }
    }

    fn token(row: Row) -> Row {
        Row { token: true, ..row }
    }

    /// Rows that between them use every shape a row has: an id with and without an oracle, a
    /// shared oracle, a split name, a name outside
    /// ASCII, an empty release date, no finishes and all three, a set and number two languages
    /// share, a promo, a token, and one printing pushed twice.
    fn rows() -> Vec<Row> {
        vec![
            row(1, Some(10), "Forest", "blb", "280", "en", "2024-08-02", &["nonfoil", "foil"]),
            row(2, Some(10), "Forest", "ltr", "0270", "en", "2023-06-23", &["nonfoil"]),
            row(3, Some(20), "Shock", "m21", "159", "ja", "2020-07-03", &["foil"]),
            row(4, Some(20), "Shock", "m21", "159", "en", "2020-07-03", &[]),
            row(5, None, "Virtue of Knowledge // Vantress Visions", "woe", "76", "en", "", &["etched"]),
            row(6, Some(30), "Lim-Dûl's Vault", "all", "107★", "en", "1996-06-10", &["nonfoil", "foil", "etched"]),
            row(7, Some(40), "Memory Lapse // Memory Lapse", "astx", "66", "en", "2021-04-23", &["nonfoil"]),
            promo(row(8, Some(41), "Memory Lapse", "sld", "2142", "en", "2025-12-01", &["foil"])),
            token(row(9, Some(42), "Ornithopter", "tdmu", "3", "en", "2022-09-09", &["nonfoil"])),
            row(1, Some(10), "Forest", "blb", "280", "en", "2024-08-02", &["nonfoil", "foil"]),
        ]
    }

    fn encoded(rows: &[Row]) -> Vec<u8> {
        let mut e = Encoder::new();
        for r in rows {
            e.push(r);
        }
        assert_eq!(e.len(), rows.len() as u64);
        e.finish()
    }

    fn bare() -> Reference {
        Reference::new()
    }

    #[test]
    fn rows_come_back_as_they_went_in_and_in_their_order() {
        let rows = rows();
        let bytes = encoded(&rows);
        let labels = decode(&bytes).expect("decode");
        assert_eq!(labels.len(), rows.len());
        assert_eq!(labels.rows().collect::<Vec<_>>(), rows);
        // Each word once: ten rows name eight names, and "Forest" is there once.
        assert_eq!(bytes.windows(6).filter(|w| w == b"Forest").count(), 1);
    }

    #[test]
    fn no_rows_is_a_file_too() {
        let bytes = Encoder::new().finish();
        assert_eq!(bytes, [b'M', b'T', b'G', b'L', VERSION, 0, 0, 0, 0, 0, 0, 0, 0]);
        let labels = decode(&bytes).expect("decode");
        assert!(labels.is_empty());
        assert_eq!(attach(&mut bare(), &bytes), Ok(0));
    }

    #[test]
    fn a_reference_attached_from_bytes_is_the_one_built_row_by_row() {
        let rows = rows();
        let mut direct = bare();
        for r in rows.clone() {
            r.attach(&mut direct);
        }
        let mut through = bare();
        assert_eq!(attach(&mut through, &encoded(&rows)), Ok(rows.len()));
        assert_eq!(through.snapshot(), direct.snapshot());
        // And the snapshot is of something: nine printings, one pushed twice.
        assert_eq!(through.label_count(), 9);
        assert_eq!(through.finishes_of(&id(6)), ["nonfoil", "foil", "etched"]);
        assert_eq!(through.label_for(&id(8)).map(|l| l.set), Some("sld".into()));
        assert!(through.is_promo(&id(8)) && !through.is_promo(&id(7)));
        assert!(through.is_token(&id(9)) && !through.is_token(&id(8)));
    }

    #[test]
    fn a_file_that_is_not_one_is_refused_in_a_sentence() {
        let bytes = encoded(&rows());
        assert_eq!(decode(b"").err(), Some(LabelsError::BadMagic));
        assert_eq!(decode(b"MTGSCAN\x01").err(), Some(LabelsError::BadMagic));
        assert_eq!(decode(b"[[\"0000419b").err(), Some(LabelsError::BadMagic));
        let mut newer = bytes.clone();
        newer[4] = VERSION + 1;
        let refused = decode(&newer).err().expect("a version this build does not read");
        assert_eq!(refused, LabelsError::BadVersion { found: VERSION + 1, expected: VERSION });
        assert_eq!(refused.to_string(), "labels format version 5, but this build understands 4");
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(matches!(decode(&longer), Err(LabelsError::Damaged { .. })), "a byte too many");
    }

    #[test]
    fn every_truncation_is_refused_and_none_panics() {
        let bytes = encoded(&rows());
        for len in 0..bytes.len() {
            let refused = decode(&bytes[..len]);
            assert!(refused.is_err(), "the first {len} of {} bytes decoded", bytes.len());
            // And nothing was attached on the way to finding out.
            let mut r = bare();
            assert!(attach(&mut r, &bytes[..len]).is_err());
            assert_eq!(r.label_count(), 0, "a refused file attached rows ({len} bytes)");
        }
    }

    #[test]
    fn no_single_wrong_byte_panics_and_a_wrong_count_is_refused() {
        let bytes = encoded(&rows());
        // Every byte, set to each of a handful of values that mean something to a varint, a
        // length or a place. Most are refused and some decode to other rows; none may panic,
        // and none may attach half a file.
        for at in 0..bytes.len() {
            for wrong in [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff] {
                let mut bad = bytes.clone();
                bad[at] = wrong;
                let mut r = bare();
                if attach(&mut r, &bad).is_err() {
                    assert_eq!(r.label_count(), 0);
                }
            }
        }
        // The row count is the sixth byte here. One more row than there is runs off the end;
        // one fewer leaves a row behind the last.
        assert_eq!(bytes[5], 10);
        let mut more = bytes.clone();
        more[5] = 11;
        assert!(matches!(decode(&more), Err(LabelsError::Truncated { .. })));
        let mut fewer = bytes.clone();
        fewer[5] = 9;
        assert!(matches!(decode(&fewer), Err(LabelsError::Damaged { .. })));
    }

    #[test]
    fn a_count_no_file_could_hold_is_refused_before_anything_is_allocated() {
        // Four billion rows, then four billion names, in a file of a few bytes: each is held
        // against what is left, so neither is a `Vec` of that size.
        let huge = [0xff, 0xff, 0xff, 0xff, 0x0f];
        let mut rows = vec![b'M', b'T', b'G', b'L', VERSION];
        rows.extend_from_slice(&huge);
        assert!(matches!(decode(&rows), Err(LabelsError::Truncated { what: "the row count", .. })));
        let mut names = vec![b'M', b'T', b'G', b'L', VERSION, 0];
        names.extend_from_slice(&huge);
        assert!(matches!(decode(&names), Err(LabelsError::Truncated { what: "name", .. })));
        // A number of eleven groups, and one whose tenth group overflows.
        let mut endless = vec![b'M', b'T', b'G', b'L', VERSION];
        endless.extend_from_slice(&[0x80; 11]);
        assert!(matches!(decode(&endless), Err(LabelsError::Damaged { .. })));
        let mut over = vec![b'M', b'T', b'G', b'L', VERSION];
        over.extend_from_slice(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02]);
        assert!(matches!(decode(&over), Err(LabelsError::Damaged { .. })));
    }

    #[test]
    fn a_word_that_is_not_utf8_is_refused() {
        let bytes = encoded(&[row(1, None, "Forest", "blb", "280", "en", "", &[])]);
        let at = bytes.windows(6).position(|w| w == b"Forest").expect("the name");
        let mut bad = bytes.clone();
        bad[at + 1] = 0xff;
        let refused = decode(&bad).err().expect("refused");
        assert_eq!(refused, LabelsError::Damaged { what: "a word that is not UTF-8", at });
        assert_eq!(
            refused.to_string(),
            format!("the labels are damaged: a word that is not UTF-8 at byte {at}")
        );
    }

    #[test]
    fn a_place_outside_its_table_is_refused() {
        let bytes = encoded(&[row(1, None, "Forest", "blb", "280", "en", "", &[])]);
        // The row is the last 24 bytes: an id, an absent oracle, five places, no finishes, and
        // the flags.
        let body = bytes.len() - MIN_ROW;
        for (offset, what) in [(ID_LEN, "id"), (ID_LEN + 1, "string"), (ID_LEN + 5, "string")] {
            let mut bad = bytes.clone();
            bad[body + offset] = 5;
            let refused = decode(&bad).err().unwrap_or_else(|| panic!("{what} place let through"));
            assert!(matches!(refused, LabelsError::Damaged { .. }), "{refused}");
        }
    }

    #[test]
    fn the_flags_are_the_promo_and_the_token_and_nothing_else() {
        let forest = || row(1, None, "Forest", "blb", "280", "en", "", &[]);
        for (r, byte) in [
            (forest(), 0),
            (promo(forest()), PROMO),
            (token(forest()), TOKEN),
            (promo(token(forest())), PROMO | TOKEN),
        ] {
            let bytes = encoded(std::slice::from_ref(&r));
            assert_eq!(bytes.last(), Some(&byte));
            let back = decode(&bytes).expect("decode").rows().next().expect("a row");
            assert_eq!((back.promo, back.token), (r.promo, r.token));
        }
        let mut bad = encoded(&[forest()]);
        *bad.last_mut().expect("a byte") = 4;
        let at = bad.len() - 1;
        let refused = decode(&bad).err().expect("refused");
        assert_eq!(refused, LabelsError::Damaged { what: "a flag this build does not know", at });
    }

    #[test]
    fn a_token_is_its_layout_or_a_two_sided_card_whose_face_is_one() {
        for layout in ["token", "double_faced_token", "emblem"] {
            assert!(is_token(layout, None), "{layout}");
            assert!(is_token(layout, Some("Card")), "a helper filed as a {layout}");
        }
        // The Role tokens and Mechtitan, and the real cards the same two layouts hold.
        let role = "Token Enchantment — Aura Role // Token Enchantment — Aura Role";
        assert!(is_token("flip", Some(role)));
        let mechtitan = "Legendary Artifact Creature — Construct // Token Legendary Artifact Creature";
        assert!(is_token("reversible_card", Some(mechtitan)));
        let monk = "Legendary Creature — Human Monk // Legendary Creature — Spirit";
        assert!(!is_token("flip", Some(monk)));
        assert!(!is_token("reversible_card", Some("Basic Land — Forest // Basic Land — Forest")));
        assert!(!is_token("flip", None));
        // An ordinary card is no token whatever its type line says of one.
        assert!(!is_token("normal", Some("Token Creature — Soldier")));
        assert!(!is_token("transform", Some("Creature — Human // Creature — Werewolf")));
    }

    // ---- Against the corpus -------------------------------------------------------------------

    #[cfg(feature = "corpus")]
    fn corpus(cards: &[[Option<&str>; 9]]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        // The app's column order for these nine, and a column of bulk between them: `finishes`
        // and `illustration_id` sit behind the oracle text in the real table.
        conn.execute_batch(
            "CREATE TABLE cards (id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT, lang TEXT,
                                 released_at TEXT, set_code TEXT, collector_number TEXT,
                                 oracle_text TEXT, finishes TEXT, illustration_id TEXT,
                                 promo INTEGER NOT NULL DEFAULT 0,
                                 layout TEXT NOT NULL DEFAULT 'normal', type_line TEXT)",
        )
        .expect("schema");
        for c in cards {
            conn.execute(
                "INSERT INTO cards (id, illustration_id, name, set_code, collector_number, lang,
                                    released_at, oracle_id, finishes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]],
            )
            .expect("insert");
        }
        conn
    }

    /// The fixture corpus: the shapes [`rows`] has, as the table holds them, and the three
    /// rows `load_labels` skips or bends — an id that is not a UUID, a name that is `NULL`,
    /// and finishes that are absent, empty and half unknown.
    #[cfg(feature = "corpus")]
    fn fixture() -> rusqlite::Connection {
        const A: &str = "0000419b-0bba-4488-8f7a-6194544ce91e";
        const B: &str = "0000579f-7b35-4ed3-b44c-db2a538066fe";
        const C: &str = "00006596-1166-4a79-8443-ca9f82e6db4e";
        const D: &str = "0000a54c-a511-4925-92dc-01b937f9afad";
        const E: &str = "0000cd57-91fe-411f-b798-646e965eec37";
        const F: &str = "00012bd8-ed68-4978-a22d-f450c8a6e048";
        const G: &str = "0001f1ef-b957-4a55-b47f-14839cdbab6f";
        const O1: &str = "b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6";
        const O2: &str = "44623693-51d6-49ad-8cd7-140505caf02f";
        const I1: &str = "8ae3562f-28b7-4462-96ed-be0cf7052ccc";
        const I2: &str = "dc4e2134-f0c2-49aa-9ea3-ebf83af1445c";
        let nonfoil_foil = Some(r#"["nonfoil","foil"]"#);
        let conn = corpus(&[
            [Some(A), Some(I1), Some("Forest"), Some("blb"), Some("280"), Some("en"), Some("2024-08-02"), Some(O1), nonfoil_foil],
            // A reprint under the same artwork, and a set and number a Japanese printing shares.
            [Some(B), Some(I1), Some("Forest"), Some("ltr"), Some("0270"), Some("ja"), Some("2023-06-23"), Some(O1), Some(r#"["foil"]"#)],
            [Some(C), Some(I2), Some("Forest"), Some("ltr"), Some("270"), Some("en"), Some("2023-06-23"), Some(O1), Some("[]")],
            // No oracle, no date, no finishes column.
            [Some(D), None, Some("Virtue of Knowledge // Vantress Visions"), Some("woe"), Some("76"), Some("en"), None, None, None],
            [Some(E), Some("not an id"), Some("Lim-Dûl's Vault"), Some("all"), Some("107★"), Some("en"), Some("1996-06-10"), Some(O2), Some(r#"["etched","glossy","nonfoil"]"#)],
            // Skipped: an id that is not one, and a row with no name.
            [Some("not-a-uuid"), None, Some("Nobody"), Some("x"), Some("0"), Some("en"), None, None, None],
            [Some(F), None, None, Some("x"), Some("1"), Some("en"), None, None, None],
            [Some(G), Some(I2), Some("Memory Lapse"), Some("sld"), Some("2142"), Some("en"), Some("2025-12-01"), Some(O2), nonfoil_foil],
        ]);
        // A promo: the column is an integer, and every other row keeps its default of 0.
        conn.execute("UPDATE cards SET promo = 1 WHERE id = ?1", [G]).expect("promo");
        // A token, by its layout.
        conn.execute(
            "UPDATE cards SET layout = 'token', type_line = 'Token Land — Forest' WHERE id = ?1",
            [B],
        )
        .expect("token");
        conn
    }

    /// Every row of `conn`, a page of `page` rows at a time.
    #[cfg(feature = "corpus")]
    fn read_all(conn: &rusqlite::Connection, page: usize) -> (Vec<u8>, usize) {
        let mut encoder = Encoder::new();
        let (mut after, mut pages) = (0, 0);
        loop {
            let read = read_page(conn, after, page, &mut encoder).expect("read");
            pages += 1;
            if read.met < page {
                break;
            }
            after = read.last.expect("a full page has a last row");
        }
        (encoder.finish(), pages)
    }

    /// **The promise**: a reference attached from the bytes the corpus was encoded to is the
    /// reference `load_labels` builds from that corpus — every index, in its order.
    #[cfg(feature = "corpus")]
    #[test]
    fn a_reference_from_the_encoded_corpus_is_the_one_load_labels_builds() {
        let conn = fixture();
        let mut loaded = bare();
        assert_eq!(loaded.load_labels(&conn).expect("load"), 6);

        for page in [1, 3, 8, 500] {
            let (bytes, pages) = read_all(&conn, page);
            let mut attached = bare();
            assert_eq!(attach(&mut attached, &bytes), Ok(6), "a page of {page}");
            assert_eq!(attached.snapshot(), loaded.snapshot(), "a page of {page}");
            // Eight rows in the table: a page of one is nine reads, the last of them empty.
            assert_eq!(pages, 8 / page + 1);
        }

        // What the snapshot stands for, asked the way a frame asks it.
        let (bytes, _) = read_all(&conn, 500);
        let mut r = bare();
        attach(&mut r, &bytes).expect("attach");
        let e = crate::ids::parse_uuid("0000cd57-91fe-411f-b798-646e965eec37").expect("id");
        assert_eq!(r.finishes_of(&e), ["etched", "nonfoil"], "the unknown word is dropped");
        let c = crate::ids::parse_uuid("00006596-1166-4a79-8443-ca9f82e6db4e").expect("id");
        assert_eq!(r.label_for(&c).map(|l| l.lang), Some("en".into()));
        assert!(r.finishes_of(&c).is_empty());
        let d = crate::ids::parse_uuid("0000a54c-a511-4925-92dc-01b937f9afad").expect("id");
        assert_eq!(r.label_for(&d).map(|l| l.released), Some(String::new()));
        assert_eq!(r.oracle_id_of(&d), None);
        let g = crate::ids::parse_uuid("0001f1ef-b957-4a55-b47f-14839cdbab6f").expect("id");
        assert!(r.is_promo(&g) && !r.is_promo(&c));
        let b = crate::ids::parse_uuid("0000579f-7b35-4ed3-b44c-db2a538066fe").expect("id");
        assert!(r.is_token(&b) && !r.is_token(&c));
    }

    /// The whole of a real corpus, for the figures and for the promise at its real size:
    ///
    /// ```text
    /// SCANNER_LABELS_CORPUS=<corpus.db> [SCANNER_LABELS_OUT=<file>] cargo test --release \
    ///   --features cli --lib labels::tests::the_whole_corpus -- --ignored --nocapture
    /// ```
    ///
    /// Prints the rows, the file's size, and how long the read, the encode and the attach
    /// took; writes the file to `SCANNER_LABELS_OUT` when that is set; and holds the reference
    /// attached from the file to the one `load_labels` builds from the same corpus.
    #[cfg(feature = "corpus")]
    #[test]
    #[ignore = "needs a real corpus: set SCANNER_LABELS_CORPUS to a corpus.db"]
    fn the_whole_corpus_encodes_to_the_reference_load_labels_builds() {
        let path = std::env::var("SCANNER_LABELS_CORPUS").expect("SCANNER_LABELS_CORPUS");
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("open the corpus");

        let t = std::time::Instant::now();
        let mut loaded = bare();
        let n = loaded.load_labels(&conn).expect("load");
        let load_ms = t.elapsed().as_secs_f64() * 1000.0;

        let t = std::time::Instant::now();
        let (bytes, pages) = read_all(&conn, 500);
        let encode_ms = t.elapsed().as_secs_f64() * 1000.0;

        let t = std::time::Instant::now();
        let mut attached = bare();
        let m = attach(&mut attached, &bytes).expect("attach");
        let attach_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = std::time::Instant::now();
        decode(&bytes).expect("decode");
        let decode_ms = t.elapsed().as_secs_f64() * 1000.0;

        println!(
            "{n} labels; {} bytes in {pages} pages of 500; load_labels {load_ms:.0} ms, read and \
             encode {encode_ms:.0} ms, decode {decode_ms:.1} ms, decode and attach {attach_ms:.0} ms",
            bytes.len()
        );
        if let Ok(out) = std::env::var("SCANNER_LABELS_OUT") {
            std::fs::write(&out, &bytes).expect("write the file");
        }
        assert_eq!(m, n);
        let (a, b) = (attached.snapshot(), loaded.snapshot());
        assert!(a == b, "the two references differ");
        // One number for everything the labels put into a reference, so a change to how
        // `Reference` keeps them can be held to the build before it: same corpus, same number.
        use std::hash::{Hash, Hasher};
        let mut digest = std::collections::hash_map::DefaultHasher::new();
        format!("{a:?}").hash(&mut digest);
        println!("snapshot digest {:016x}", digest.finish());
    }
}
