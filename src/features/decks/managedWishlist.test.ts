import { describe, expect, it } from "vitest";
import {
  MANAGED_WISHLIST_HINT,
  MANAGED_WISHLIST_LABEL,
  MANAGED_WISHLIST_MODES,
  MANAGED_WISHLIST_TOKENS_HINT,
  MANAGED_WISHLIST_TOKENS_LABEL,
  managedWishlistHistoryLabel,
  managedWishlistMode,
} from "./managedWishlist";

/**
 * The managed wishlist's words — the Deck settings row draws them and the history line names a
 * mode by them, so this module is their one home.
 */
describe("the managed wishlist's modes", () => {
  /**
   * **Four words since user schema v57** (issue #617): the choices follow Compare's three card
   * views in the dialog's own order, and `tokens` — the fifth word from v55 to v56 — left the
   * group to become a switch beside it.
   */
  it("offers Off and the Compare dialog's three card views, and no Tokens mode", () => {
    expect(MANAGED_WISHLIST_MODES).toEqual(["off", "all", "missing", "other"]);
    expect(MANAGED_WISHLIST_LABEL).not.toHaveProperty("tokens");
    expect(MANAGED_WISHLIST_TOKENS_LABEL).toBe("Tokens");
  });

  /** The switch reaches all three views alike, so no mode's caption may say anything about
   *  tokens — a caption that did would be true under one setting of a switch it cannot see. */
  it("keeps tokens out of every mode's caption", () => {
    for (const mode of MANAGED_WISHLIST_MODES) {
      expect(MANAGED_WISHLIST_HINT[mode]).not.toMatch(/token/i);
    }
  });

  /** The switch's own sentence names the subfolder, which is where a reader will look — and
   *  says how the mode compares a token (issue #675): by name under Missing, by exact printing
   *  and finish under the other two. */
  it("says the tokens switch files missing tokens in a Tokens subfolder, matched per mode", () => {
    expect(MANAGED_WISHLIST_TOKENS_HINT).toEqual({
      all: "Missing tokens go in its Tokens subfolder, matched by exact printing and finish.",
      missing: "Missing tokens go in its Tokens subfolder, matched by name in any printing.",
      other: "Missing tokens go in its Tokens subfolder, matched by exact printing and finish.",
    });
  });

  it("reads the stored word, and anything else — the retired tokens included — as off", () => {
    expect(managedWishlistMode("other")).toBe("other");
    expect(managedWishlistMode("tokens")).toBe("off");
    expect(managedWishlistMode("stacked")).toBe("off");
  });

  /** History outlives the vocabulary: a v55 log row can say `tokens`, and it happened. */
  it("names a recorded mode for history, keeping the retired Tokens word", () => {
    expect(managedWishlistHistoryLabel("missing")).toBe("Missing");
    expect(managedWishlistHistoryLabel("tokens")).toBe("Tokens");
    expect(managedWishlistHistoryLabel("off")).toBeNull();
    expect(managedWishlistHistoryLabel("stacked")).toBeNull();
    expect(managedWishlistHistoryLabel(3)).toBeNull();
  });
});
