//! The Rust half of a transfer — the card shape both halves speak, and the two axes an export
//! is written along.
//!
//! **This is a port, not a second design.** `src/features/transfer/TransferCard.ts` is the
//! source of truth for the field list and `src/features/transfer/formats.ts` for the format
//! list; everything here is those files spelled in Rust. The thing that keeps the two copies
//! honest is the shared corpus at `src/features/transfer/__golden__/corpus.json` — written on
//! the TypeScript side, read here through [`card::load_corpus`] with `deny_unknown_fields`, so
//! a field added over there is a red `cargo test` here rather than a column silently missing
//! from every mirrored file.
//!
//! **Two axes, declared apart, exactly as `fields.ts` declares them.** A [`Surface`] says what
//! facts a list *holds* — a deck has no purchase history, a wishlist has no piles — and a
//! [`Format`] says what channels a file *has*. Neither may be derived from the other: what a
//! reader can switch on is the overlap, and folding the two into one enum is how a deck grows a
//! Condition column of blanks.

pub mod card;

pub use card::{load_corpus, Card, CorpusFile, Scenario, Scenarios};

use serde::Deserialize;

/// Which of the app's three lists a set of cards came from.
///
/// The lowercase words are the corpus's: `"deck"`, `"collection"`, `"wishlist"`, matching
/// `TransferSurface` in `src/features/transfer/fields.ts`. They are a serialisation contract
/// rather than a display name — nothing here is ever drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    Deck,
    Collection,
    Wishlist,
}

impl Surface {
    /// Every surface. A sweep over this is how a suite covers all three without a list of
    /// three written down at each call site and forgotten when a fourth arrives.
    pub const ALL: [Self; 3] = [Self::Deck, Self::Collection, Self::Wishlist];
}

/// A format a transfer can be written to.
///
/// The order is `EXPORT_FORMATS`' in `src/features/transfer/formats.ts` — `plain · mtgo ·
/// arena · moxfield · archidekt · tcgplayer · csv` — because a golden file is named
/// `<scenario>.<format>.<fieldset>.txt` and a sweep on either side has to be able to find what
/// the other wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Plain,
    Mtgo,
    Arena,
    Moxfield,
    Archidekt,
    Tcgplayer,
    Csv,
}

impl Format {
    /// Every format, in `EXPORT_FORMATS`' own order.
    pub const ALL: [Self; 7] = [
        Self::Plain,
        Self::Mtgo,
        Self::Arena,
        Self::Moxfield,
        Self::Archidekt,
        Self::Tcgplayer,
        Self::Csv,
    ];

    /// The format's wire word — the string `EXPORT_FORMATS` uses.
    ///
    /// **A spelling, not a label.** `EXPORT_FORMAT_LABEL` holds `TCGplayer` and `Plain text`
    /// for the radio row; this is what a golden filename and a stored preference are keyed by,
    /// so the two must never be confused and this one must never be prettified.
    pub fn key(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Mtgo => "mtgo",
            Self::Arena => "arena",
            Self::Moxfield => "moxfield",
            Self::Archidekt => "archidekt",
            Self::Tcgplayer => "tcgplayer",
            Self::Csv => "csv",
        }
    }

    /// The extension a written file takes — `EXPORT_FORMAT_EXTENSION`'s answer.
    ///
    /// CSV is the one format here that is not a decklist in plain text, and it is the one the
    /// operating system has an opinion about: a `.txt` spreadsheet opens in Notepad.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            _ => "txt",
        }
    }
}
