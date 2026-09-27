/**
 * Which Compare view a deck's **managed wishlist** follows — `decks.managed_wishlist_mode`, user
 * schema v49 (issue #512).
 *
 * The four views are `TheoryDiffDialog`'s own `All | Missing | Different printing | Tokens`, and
 * the folder holds each view's own copies: every shortfall, the copies no printing in the deck
 * covers, the copies the deck plays as another printing, or the token printings the plan is short
 * of. `off` — the default — is no folder. This module is the words' one home, so the Deck
 * settings group and the history line cannot come to name one choice two ways.
 *
 * **`tokens` since user schema v54** (managed tokens spec §3.8). The token rows' wishes are filed
 * in a `Tokens` subfolder inside the deck's folder — by `All`, beside its cards, and by `Tokens`,
 * alone — and `Missing` and `Different printing` leave tokens out, as their Compare views do. So
 * two captions name the subfolder, and the other two say nothing about tokens at all.
 */

import type { ManagedWishlistMode } from "@/lib/ipc";

/** The five choices in the order the group paints them: nothing first, then the dialog's order —
 *  which puts `Tokens` last, where the Compare dialog's own ladder puts it. */
export const MANAGED_WISHLIST_MODES: readonly ManagedWishlistMode[] = [
  "off",
  "all",
  "missing",
  "other",
  "tokens",
];

/** Each choice's word — the dialog's own tab words for the four views. */
export const MANAGED_WISHLIST_LABEL: Record<ManagedWishlistMode, string> = {
  off: "Off",
  all: "All",
  missing: "Missing",
  other: "Different Printing",
  tokens: "Tokens",
};

/** One line for the caption under the group — the selected choice's, and only it. */
export const MANAGED_WISHLIST_HINT: Record<ManagedWishlistMode, string> = {
  off: "No managed wishlist for this deck.",
  all: "A wishlist folder named after this deck that holds everything the Compare dialog lists, its tokens in a Tokens subfolder. It follows the deck and can't be edited by hand.",
  missing:
    "A wishlist folder named after this deck that holds the cards the deck doesn't play in any printing. It follows the deck and can't be edited by hand.",
  other:
    "A wishlist folder named after this deck that holds the planned printings of cards the deck plays in a different printing. It follows the deck and can't be edited by hand.",
  tokens:
    "A wishlist folder named after this deck, with a Tokens subfolder that holds the token printings the plan is short of. It follows the deck and can't be edited by hand.",
};

/**
 * A stored word read leniently — Rust already answers one of the five, so this is a fence for a
 * fake or a fixture rather than a case the app produces.
 */
export function managedWishlistMode(value: string): ManagedWishlistMode {
  return (MANAGED_WISHLIST_MODES as readonly string[]).includes(value)
    ? (value as ManagedWishlistMode)
    : "off";
}
