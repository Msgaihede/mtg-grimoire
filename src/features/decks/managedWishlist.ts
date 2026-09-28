/**
 * Which Compare view a deck's **managed wishlist** follows — `decks.managed_wishlist_mode`, user
 * schema v49 (issue #512) — and whether it files the plan's tokens as well —
 * `decks.managed_wishlist_tokens`, user schema v57 (issue #617).
 *
 * The three views are `TheoryDiffDialog`'s own card readings, `All | Missing | Different
 * printing`, and the folder holds each one's own copies: every card shortfall, the copies no
 * printing in the deck covers, or the copies the deck plays as another printing. `off` — the
 * default — is no folder. This module is the words' one home, so the Deck settings row and the
 * history line cannot come to name one choice two ways.
 *
 * **Tokens are a switch beside the mode, not a fifth mode** (issue #617). From v55 to v56 they
 * were both: `All` filed the token rows beside its cards and `Tokens` filed them alone, so a
 * reader who wanted Missing cards *and* their Treasures had no word for it. v57 split the two
 * questions — the mode says which card copies the folder wants, the switch says whether a
 * `Tokens` subfolder inside it holds the token printings the plan is short of — and the switch
 * reaches all three views alike. So no mode's caption mentions tokens at all; the switch has its
 * own sentence, {@link MANAGED_WISHLIST_TOKENS_HINT}, drawn after the mode's when it is on.
 */

import type { ManagedWishlistMode } from "@/lib/ipc";

/** The four choices in the order the group paints them: nothing first, then the dialog's order.
 *  The Compare dialog's fourth view, `Tokens`, is not among them — it is
 *  {@link MANAGED_WISHLIST_TOKENS_LABEL}'s switch, drawn beside the group rather than in it. */
export const MANAGED_WISHLIST_MODES: readonly ManagedWishlistMode[] = [
  "off",
  "all",
  "missing",
  "other",
];

/** Each choice's word — the dialog's own tab words for the three card views. */
export const MANAGED_WISHLIST_LABEL: Record<ManagedWishlistMode, string> = {
  off: "Off",
  all: "All",
  missing: "Missing",
  other: "Different Printing",
};

/** One line for the caption under the row — the selected choice's, and only it. */
export const MANAGED_WISHLIST_HINT: Record<ManagedWishlistMode, string> = {
  off: "No managed wishlist for this deck.",
  all: "Wishlist folder for everything the Compare dialog lists. Updates automatically; can't be edited.",
  missing:
    "Wishlist folder for cards this deck doesn't have in any printing. Updates automatically; can't be edited.",
  other:
    "Wishlist folder for the theory list's printings of cards you play in a different printing. Updates automatically; can't be edited.",
};

/** The tokens switch's word — the Compare dialog's own tab word for the view it files, and the
 *  name of the subfolder it fills. */
export const MANAGED_WISHLIST_TOKENS_LABEL = "Tokens";

/**
 * The tokens switch's sentence, appended to the mode's caption while it is on. It names the
 * subfolder, because that is where a reader will go looking and nothing else on the screen says
 * where the wishes went; it says nothing about the mode, because it is true under all three.
 */
export const MANAGED_WISHLIST_TOKENS_HINT =
  "Missing tokens go in its Tokens subfolder.";

/**
 * A stored word read leniently — Rust already answers one of the four, so this is a fence for a
 * fake or a fixture rather than a case the app produces. **`tokens` is not read here**: v57
 * rewrote every such deck, and the one place the word can still be met — an old history row —
 * is {@link managedWishlistHistoryLabel}'s to name.
 */
export function managedWishlistMode(value: string): ManagedWishlistMode {
  return (MANAGED_WISHLIST_MODES as readonly string[]).includes(value)
    ? (value as ManagedWishlistMode)
    : "off";
}

/**
 * The word a **history line** names a recorded mode by, or `null` for `off`.
 *
 * Distinct from {@link managedWishlistMode} because history outlives the vocabulary: a deck's
 * log written between v55 and v56 can hold `"tokens"`, which v57 migrated on the deck and could
 * not migrate in the log — a row there is what happened, not a setting. Read through the
 * four-word fence it would print *Turned the managed wishlist off*, a sentence about an event that
 * never occurred; so the retired word keeps its old label here and nowhere else. Anything else
 * unknown is `off`, the fence's answer.
 */
export function managedWishlistHistoryLabel(value: unknown): string | null {
  if (value === "tokens") return MANAGED_WISHLIST_TOKENS_LABEL;
  const mode = typeof value === "string" ? managedWishlistMode(value) : "off";
  return mode === "off" ? null : MANAGED_WISHLIST_LABEL[mode];
}
