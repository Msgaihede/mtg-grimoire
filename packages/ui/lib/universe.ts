/**
 * Universes Beyond or Universes Within — the filter tray's **Universe** cell.
 *
 * **One Scryfall word and its complement.** `beyond` is a printing whose `promo_types` holds
 * `universesbeyond` (what Scryfall's own `is:universesbeyond` reads), and `within` is every
 * printing that does not — Scryfall keeps no "Universes Within" word, so the second half is
 * the rest of the corpus rather than a list anybody maintains. The two partition the
 * printings, which is why the filter is one value and not two chips: both at once is no
 * filter, and that is what an absent `universe` already says.
 *
 * **A printing's fact, not a card's**: a Sol Ring printed in a Lord of the Rings Commander deck
 * is `beyond` and its other printings are `within`, so a collapsed search answers either value
 * with Sol Ring, represented by a printing that matches. `filters::UNIVERSE_KEYS` in Rust
 * holds the same two words and reads anything else as no filter.
 */
export const UNIVERSES = ["beyond", "within"] as const;
export type Universe = (typeof UNIVERSES)[number];

export const UNIVERSE_LABEL: Record<Universe, string> = {
  beyond: "Beyond",
  within: "Within",
};

/** The stated-filter chip's words, which stand alone where the cell's label is not beside them. */
export const UNIVERSE_CHIP_LABEL: Record<Universe, string> = {
  beyond: "Universes Beyond",
  within: "Universes Within",
};
