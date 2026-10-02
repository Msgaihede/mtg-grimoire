//! Folding a name to the key two spellings of it share.
//!
//! Here rather than in [`crate::tags`] because the fold is a fact about a *slug*, and
//! [`crate::schema`] is its one caller outside that module.

/// A tag name reduced to what Scryfall matches on: lowercase, every non-alphanumeric
/// removed.
///
/// **One copy, deliberately.** The ingest writes it into `slug_norm` and the search
/// compares a typed needle against that column; if the two ever normalised differently the
/// search would match nothing and no test would fail, because each half would still be
/// self-consistent.
///
/// Verified live 2026-08-20 — `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval`
/// and `otag:SPOT-REMOVAL` all return exactly 4,907 cards.
pub fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four spellings are the ones measured against Scryfall on 2026-08-20:
    /// `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and
    /// `otag:SPOT-REMOVAL` each returned exactly 4,907 cards, so all four have to fold to
    /// one key here.
    #[test]
    fn every_spelling_of_a_tag_name_normalises_to_one_key() {
        for spelling in [
            "spot removal",
            "spot-removal",
            "spotremoval",
            "SPOT-REMOVAL",
        ] {
            assert_eq!(normalize(spelling), "spotremoval", "{spelling}");
        }

        // Digits are kept — `cycle-2` and `cycle2` are one tag, and dropping the 2 would
        // fold it onto `cycle`.
        assert_eq!(normalize("Cycle-2"), "cycle2");
        // And a name with nothing alphanumeric in it normalises to nothing, which is a
        // needle that matches no row rather than one that matches every row.
        assert_eq!(normalize("---"), "");
    }
}
