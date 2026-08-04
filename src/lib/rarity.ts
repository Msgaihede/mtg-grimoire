/**
 * Rarity, as a colour.
 *
 * Four tokens and a fallback. The direction spends its colour budget on mana and card
 * art, so a rarity gets a 6px gem or a tinted word — never a filled badge, which at
 * mythic orange would out-shout the art it sits under.
 */
export function rarityColor(rarity: string | null): string {
  switch (rarity) {
    case "common":
      return "var(--color-rarity-common)";
    case "uncommon":
      return "var(--color-rarity-uncommon)";
    case "rare":
      return "var(--color-rarity-rare)";
    case "mythic":
      return "var(--color-rarity-mythic)";
    // `special` and `bonus` exist in the data and have no token of their own.
    default:
      return "var(--color-border)";
  }
}
