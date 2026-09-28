import { describe, expect, it } from "vitest";
import {
  MANAGED_WISHLIST_HINT,
  MANAGED_WISHLIST_LABEL,
  MANAGED_WISHLIST_MODES,
  managedWishlistMode,
} from "./managedWishlist";

/**
 * The managed wishlist's words — the Deck settings group draws them and the history line names a
 * mode by them, so this module is their one home.
 */
describe("the managed wishlist's modes", () => {
  /**
   * **`tokens` since user schema v55** (managed tokens spec §3.8): the choices follow Compare's
   * views, and Compare gained `Tokens` last — so the group paints it last, after the three views
   * it already offered, in the dialog's own order.
   */
  it("offers the Tokens mode last, in the Compare dialog's order", () => {
    expect(MANAGED_WISHLIST_MODES).toEqual(["off", "all", "missing", "other", "tokens"]);
    expect(MANAGED_WISHLIST_LABEL.tokens).toBe("Tokens");
  });

  /** Its caption is in the others' voice, and says the one thing that differs: the wishes are
   *  in a `Tokens` subfolder, and they are the token printings the plan is short of. */
  it("says the Tokens mode files the plan's missing token printings in a Tokens subfolder", () => {
    expect(MANAGED_WISHLIST_HINT.tokens).toBe(
      "A wishlist folder named after this deck, with a Tokens subfolder that holds the token printings the plan is short of. It follows the deck and can't be edited by hand.",
    );
  });

  /** All fills that subfolder too, so its caption says so rather than leaving a reader to find a
   *  folder nothing on this screen mentioned. */
  it("says All keeps its tokens in the Tokens subfolder", () => {
    expect(MANAGED_WISHLIST_HINT.all).toMatch(/Tokens subfolder/);
    expect(MANAGED_WISHLIST_HINT.missing).not.toMatch(/token/i);
    expect(MANAGED_WISHLIST_HINT.other).not.toMatch(/token/i);
  });

  it("reads the stored word, tokens included, and anything else as off", () => {
    expect(managedWishlistMode("tokens")).toBe("tokens");
    expect(managedWishlistMode("other")).toBe("other");
    expect(managedWishlistMode("stacked")).toBe("off");
  });
});
