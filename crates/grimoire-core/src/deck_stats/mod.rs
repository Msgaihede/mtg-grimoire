//! Deck statistics and draw odds — **the Rust port of the deck page's arithmetic**:
//! `packages/ui/features/decks/DeckStats.tsx`' `deckStats`, the parts of `deckBuckets.ts` and
//! `packages/ui/lib/mana.ts` it reads, `stats/typeBreakdownCounts.ts` and `openingHand.ts`.
//!
//! **A port, not a second design**, held to the TypeScript by the goldens under
//! `packages/ui/features/decks/__golden__/` exactly as [`crate::deck_rules`] is (its module doc
//! says how). What is ported is the arithmetic the page draws conclusions with — never chart
//! geometry, labels or display folding.
//!
//! [`mana`] is the cost tokeniser and pip counts, [`buckets`] the type and curve buckets and the
//! card filters (`sized_cards`, `library_cards`), [`summary`] the `DeckStatsSummary`, [`types`]
//! the type breakdown and [`odds`] the hypergeometric draw odds.

pub mod buckets;
pub mod mana;
pub mod odds;
pub mod summary;
pub mod types;
