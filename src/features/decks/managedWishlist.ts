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
  all: "Auto-synced wishlist folder containing all cards from the Compare list.",
  missing:
    "Auto-synced wishlist folder containing unowned cards needed for this deck.",
  other:
    "Auto-synced wishlist folder containing target printings for cards currently played in other versions.",
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
