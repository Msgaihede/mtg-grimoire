//! A fixed-size bitset over `cards.rowid`, one bit per printing.
//!
//! 116 694 printings is 1 824 machine words — 14 KB — so intersecting two filters is an
//! `AND` and a `popcount` over 14 KB rather than a query. The whole low-cardinality half of
//! [`super::CardIndex`] is 40 of these.

/// One bit per rowid. Rowid 0 is never used by SQLite, so index 0 is simply always clear.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitSet {
    words: Vec<u64>,
}

const BITS: usize = 64;

impl BitSet {
    /// `capacity` is a floor, not a ceiling: it is rounded up to a whole word, and the set
    /// then holds *every* doc below [`BitSet::capacity`] — `new(100)` takes two words and
    /// holds doc 127, not 99. Pass `max_rowid + 1`.
    ///
    /// **Size any sibling array indexed by the same doc ids from [`BitSet::capacity`], never
    /// from the number passed here.** The two differ by up to 63, and [`BitSet::set`]
    /// deliberately *accepts* a doc that lands in that padding window rather than dropping
    /// it — so [`BitSet::for_each`] can emit a doc past the end of an array sized from this
    /// argument. Sizing from `capacity()` is what makes that impossible rather than merely
    /// unlikely.
    pub fn new(capacity: usize) -> Self {
        BitSet {
            words: vec![0; capacity.div_ceil(BITS)],
        }
    }

    /// Rounded up to a whole word, so this reports what the set genuinely holds rather than
    /// what `new` was asked for: `new(100)` answers 128, and doc 127 set on it stays set.
    /// Rounding *up* is the load-bearing half — rounding down would silently drop the last
    /// rowids of a corpus, which is exactly the stale answer [`BitSet::set`] exists to avoid.
    pub fn capacity(&self) -> usize {
        self.words.len() * BITS
    }

    /// A doc past the end is dropped. The alternative is a panic on a database that grew
    /// between the build and the query, which is a crash rather than a stale answer.
    pub fn set(&mut self, doc: u32) {
        let (w, b) = (doc as usize / BITS, doc as usize % BITS);
        if let Some(word) = self.words.get_mut(w) {
            *word |= 1u64 << b;
        }
    }

    pub fn contains(&self, doc: u32) -> bool {
        let (w, b) = (doc as usize / BITS, doc as usize % BITS);
        self.words
            .get(w)
            .is_some_and(|word| word & (1u64 << b) != 0)
    }

    /// Shorter operand wins: two sets built against different capacities intersect over
    /// what they share, which is the only honest answer.
    pub fn and(&self, other: &BitSet) -> BitSet {
        let n = self.words.len().min(other.words.len());
        BitSet {
            words: (0..n).map(|i| self.words[i] & other.words[i]).collect(),
        }
    }

    pub fn and_count(&self, other: &BitSet) -> u32 {
        let n = self.words.len().min(other.words.len());
        (0..n)
            .map(|i| (self.words[i] & other.words[i]).count_ones())
            .sum()
    }

    pub fn count(&self) -> u32 {
        self.words.iter().map(|w| w.count_ones()).sum()
    }

    /// Ascending, and skipping empty words wholesale — the sets facet walks up to 107 337
    /// docs through this on every keystroke.
    pub fn for_each(&self, mut f: impl FnMut(u32)) {
        for (i, word) in self.words.iter().enumerate() {
            let mut w = *word;
            while w != 0 {
                let bit = w.trailing_zeros();
                f((i * BITS) as u32 + bit);
                w &= w - 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bit_that_was_set_is_the_only_one_present() {
        let mut b = BitSet::new(200);
        b.set(0);
        b.set(63);
        b.set(64);
        b.set(199);
        assert!(b.contains(0) && b.contains(63) && b.contains(64) && b.contains(199));
        assert!(!b.contains(1) && !b.contains(65));
        assert_eq!(b.count(), 4);
    }

    /// The word boundary is where an off-by-one lives, so it is tested on both sides.
    #[test]
    fn intersection_counts_only_what_both_hold() {
        let mut a = BitSet::new(200);
        let mut b = BitSet::new(200);
        for d in [1, 63, 64, 65, 128] {
            a.set(d);
        }
        for d in [63, 65, 199] {
            b.set(d);
        }
        assert_eq!(a.and_count(&b), 2);
        assert_eq!(a.and(&b).count(), 2);
        assert!(a.and(&b).contains(63) && a.and(&b).contains(65));
    }

    /// `for_each` is how the set-ordinal walk reads its docs, so it must visit every set bit
    /// exactly once and in ascending order.
    #[test]
    fn for_each_visits_every_set_bit_once_in_order() {
        let mut b = BitSet::new(300);
        for d in [5, 64, 130, 299] {
            b.set(d);
        }
        let mut seen = Vec::new();
        b.for_each(|d| seen.push(d));
        assert_eq!(seen, vec![5, 64, 130, 299]);
    }

    /// A capacity that is not a multiple of 64 is rounded up to one, and `capacity` reports
    /// the rounded figure — 128 here, not the 100 asked for — because that is what the set
    /// really holds: the tail of the last word is usable storage, and doc 127 set on it stays
    /// set. Rounding *up* rather than down is what keeps the last rowids of a corpus
    /// addressable, and it is why a sibling array indexed by the same docs must be sized from
    /// `capacity()` and never from the argument to `new`.
    #[test]
    fn a_ragged_capacity_rounds_up_to_a_whole_word() {
        let mut b = BitSet::new(100);
        assert_eq!(b.count(), 0);
        assert!(!b.contains(99));
        assert_eq!(b.capacity(), 128);
        b.set(127);
        assert!(b.contains(127));
        assert_eq!(b.count(), 1);
    }

    /// Out-of-range writes are dropped rather than panicking: rowids come from a database
    /// that a sync can grow between the build and the query.
    #[test]
    fn a_doc_past_capacity_is_ignored_rather_than_panicking() {
        let mut b = BitSet::new(64);
        b.set(1000);
        assert_eq!(b.count(), 0);
        assert!(!b.contains(1000));
    }
}
