import { describe, expect, it } from "vitest";
import { rarityColor } from "@/lib/rarity";

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
});
