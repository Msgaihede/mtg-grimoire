/**
 * Which Compare view a deck's **managed wishlist** follows — `decks.managed_wishlist_mode`, user
 * schema v49 (issue #512).
 *
 * The three views are `TheoryDiffDialog`'s own `All | Missing | Different printing`, and the
 * folder holds each view's own copies: every shortfall, the copies no printing in the deck
 * covers, or the copies the deck plays as another printing. `off` — the default — is no folder.
 * This module is the words' one home, so the Deck settings group and the history line cannot
 * come to name one choice two ways.
 */

import type { ManagedWishlistMode } from "@/lib/ipc";

/** The four choices in the order the group paints them: nothing first, then the dialog's order. */
export const MANAGED_WISHLIST_MODES: readonly ManagedWishlistMode[] = [
  "off",
  "all",
  "missing",
  "other",
];

/** Each choice's word — the dialog's own tab words for the three views. */
export const MANAGED_WISHLIST_LABEL: Record<ManagedWishlistMode, string> = {
  off: "Off",
  all: "All",
  missing: "Missing",
  other: "Different Printing",
};

/** One line for the caption under the group — the selected choice's, and only it. */
export const MANAGED_WISHLIST_HINT: Record<ManagedWishlistMode, string> = {
  off: "No managed wishlist for this deck.",
  all: "A wishlist folder named after this deck that holds everything the Compare dialog lists. It follows the deck and can't be edited by hand.",
  missing:
    "A wishlist folder named after this deck that holds the cards the deck doesn't play in any printing. It follows the deck and can't be edited by hand.",
  other:
    "A wishlist folder named after this deck that holds the planned printings of cards the deck plays in a different printing. It follows the deck and can't be edited by hand.",
};

/**
 * A stored word read leniently — Rust already answers one of the four, so this is a fence for a
 * fake or a fixture rather than a case the app produces.
 */
export function managedWishlistMode(value: string): ManagedWishlistMode {
  return (MANAGED_WISHLIST_MODES as readonly string[]).includes(value)
    ? (value as ManagedWishlistMode)
    : "off";
}
