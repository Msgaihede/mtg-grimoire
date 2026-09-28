//! Reading a bulk feed a chunk at a time — and, in [`backoff`], when to stop asking for one.

pub mod backoff;
pub mod frame;

/// **The floor every bulk ingest holds before it swaps: a file more unusable than usable is a bad
/// download, not a smaller catalogue** (issue #551).
///
/// Each ingest already refused a file with *nothing* in it — `Empty`, in all four — but one good
/// row among a hundred thousand bad ones swapped: the card corpus down to a handful of printings,
/// with every collection row flagged for review and the mirror rewritten with blank names; a
/// taxonomy of one tag, held for a week behind its ETag; a price table of em dashes under a fresh
/// as-of line. Strictly greater, so a file that is exactly half usable still swaps.
///
/// Where the healthy files sit, from the measurements in `docs/`: 0 skipped of 116 568 card lines,
/// 0 of 4 521 oracle-tag and 11 531 art-tag lines, 1.4 % of the combo file's variants, 0.55 % of
/// Card Kingdom's rows for a missing id, and at most 16 % of Mana Pool's — so the nearest healthy
/// feed is three times inside the line and the others thirty-five.
pub fn mostly_unusable(kept: u64, skipped: u64) -> bool {
    skipped > kept
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_file_more_unusable_than_usable_is_refused_and_one_exactly_half_is_not() {
        assert!(!super::mostly_unusable(116_568, 0));
        assert!(
            !super::mostly_unusable(84, 16),
            "Mana Pool at its measured worst"
        );
        assert!(!super::mostly_unusable(2, 2), "exactly half still swaps");
        assert!(super::mostly_unusable(2, 3));
        assert!(super::mostly_unusable(1, 199_999));
    }
}
