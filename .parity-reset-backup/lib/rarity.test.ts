import { describe, expect, it } from "vitest";
import { hasRarityColor, rarityColor } from "@/lib/rarity";

describe("rarityColor", () => {
  it("maps the four rarities the direction names", () => {
    expect(rarityColor("common")).toBe("var(--color-rarity-common)");
    expect(rarityColor("mythic")).toBe("var(--color-rarity-mythic)");
  });

  /**
   * Scryfall also emits `special` and `bonus`, and `rarity` is nullable. Neither has a
   * token, and inventing one would be a colour claim the direction did not make — the
   * border colour reads as "no rarity stated", which is the truth.
   */
  it("makes no colour claim about a rarity it has no token for", () => {
    expect(rarityColor("special")).toBe("var(--color-border)");
    expect(rarityColor("bonus")).toBe("var(--color-border)");
    expect(rarityColor(null)).toBe("var(--color-border)");
  });

  /**
   * Not a restatement of the above: it is the question anything that tints *text* has to ask
   * first. The fallback is a legitimate colour for 6px of dot and an illegible one for a
   * word (~1.9:1 on the app background), so the two uses cannot read the same answer.
   */
  it("says when the colour is a shrug rather than a claim", () => {
    expect(hasRarityColor("mythic")).toBe(true);
    expect(hasRarityColor("special")).toBe(false);
    expect(hasRarityColor("bonus")).toBe(false);
    expect(hasRarityColor(null)).toBe(false);
    // Not a rarity at all, and not an inherited `Object.prototype` key either — a record
    // read with `in` would answer `true` to this one.
    expect(hasRarityColor("toString")).toBe(false);
  });
});
